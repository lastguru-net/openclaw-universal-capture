import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-runtime"

import type { ConversationCaptureEntry } from "./capture.js"
import type { UniversalCaptureConfig } from "./config.js"

export type RecallEntry = {
  timestamp: string
  sessionId?: string
  sessionKey: string
  senderUsername?: string
  userText: string
  assistantText: string
}

type RecallReadResult = {
  entries: RecallEntry[]
  malformedLines: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function sessionKeySlug(sessionKey: string): string {
  const slug = sessionKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return (slug || "session").slice(0, 180).replace(/-+$/g, "") || "session"
}

function safeSessionKeyFileName(sessionKey: string): string {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 12)
  return `${sessionKeySlug(sessionKey)}-${hash}.ndjson`
}

export function resolveRecallFilePath(params: {
  workspaceDir: string
  recallFolder: string
  sessionKey: string
}): string {
  return resolve(
    params.workspaceDir,
    params.recallFolder,
    safeSessionKeyFileName(params.sessionKey),
  )
}

function parseRecallEntry(value: unknown): RecallEntry | undefined {
  if (!isRecord(value)) return undefined

  const timestamp = asOptionalString(value.timestamp)
  const sessionKey = asOptionalString(value.sessionKey)
  const userText = asOptionalString(value.userText)
  const assistantText = asOptionalString(value.assistantText)
  if (!timestamp || !sessionKey || userText === undefined || assistantText === undefined) {
    return undefined
  }

  return {
    timestamp,
    ...(asOptionalString(value.sessionId) ? { sessionId: asOptionalString(value.sessionId) } : {}),
    sessionKey,
    ...(asOptionalString(value.senderUsername)
      ? { senderUsername: asOptionalString(value.senderUsername) }
      : {}),
    userText,
    assistantText,
  }
}

export function parseRecallLines(text: string): RecallReadResult {
  const entries: RecallEntry[] = []
  let malformedLines = 0

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = parseRecallEntry(JSON.parse(line))
      if (entry) entries.push(entry)
      else malformedLines += 1
    } catch {
      malformedLines += 1
    }
  }

  return { entries, malformedLines }
}

async function readRecallFile(filePath: string): Promise<RecallReadResult> {
  try {
    return parseRecallLines(await readFile(filePath, "utf8"))
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { entries: [], malformedLines: 0 }
    }
    throw error
  }
}

function serializeEntries(entries: RecallEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
}

function pruneRecallEntries(params: {
  entries: RecallEntry[]
  recallTurns: number
  recallMaxBytes: number
}): RecallEntry[] {
  let entries = params.entries.slice(-params.recallTurns)

  if (params.recallMaxBytes > 0) {
    while (
      entries.length > 1 &&
      Buffer.byteLength(serializeEntries(entries), "utf8") > params.recallMaxBytes
    ) {
      entries = entries.slice(1)
    }
  }

  return entries
}

export async function writeRecallEntries(params: {
  workspaceDir: string
  config: UniversalCaptureConfig
  sessionId?: string
  sessionKey: string
  entries: ConversationCaptureEntry[]
}): Promise<{ written: number; malformedLines: number }> {
  if (params.config.recallTurns <= 0 || params.entries.length === 0) {
    return { written: 0, malformedLines: 0 }
  }

  const filePath = resolveRecallFilePath({
    workspaceDir: params.workspaceDir,
    recallFolder: params.config.recallFolder,
    sessionKey: params.sessionKey,
  })
  const existing = await readRecallFile(filePath)
  const nextEntries = pruneRecallEntries({
    entries: [
      ...existing.entries,
      ...params.entries.map((entry) => ({
        timestamp: entry.timestamp,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        sessionKey: params.sessionKey,
        ...(entry.senderUsername ? { senderUsername: entry.senderUsername } : {}),
        userText: entry.userText,
        assistantText: entry.assistantText,
      })),
    ],
    recallTurns: params.config.recallTurns,
    recallMaxBytes: params.config.recallMaxBytes,
  })

  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = resolve(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    await writeFile(tmpPath, serializeEntries(nextEntries), "utf8")
    await rename(tmpPath, filePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }

  return { written: params.entries.length, malformedLines: existing.malformedLines }
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let result = ""
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8")
    if (bytes + charBytes > maxBytes) break
    result += char
    bytes += charBytes
  }
  return result
}

function renderRecallEntry(entry: RecallEntry): string {
  return [
    `Timestamp: ${entry.timestamp}`,
    ...(entry.senderUsername ? [`Sender: ${entry.senderUsername}`] : []),
    "",
    "User:",
    entry.userText,
    "",
    "Assistant:",
    entry.assistantText,
  ].join("\n")
}

export function renderRecallToolOutput(params: {
  entries: RecallEntry[]
  malformedLines: number
  recallMaxBytes: number
}): string {
  if (params.entries.length === 0) {
    return params.malformedLines > 0
      ? `No valid recalled turns found. Ignored ${params.malformedLines} malformed recall line${params.malformedLines === 1 ? "" : "s"}.`
      : "No recalled turns found for this session."
  }

  const renderedEntries = params.entries.map(renderRecallEntry)
  const separator = "\n\n---\n\n"
  let text = renderedEntries.join(separator)
  if (params.malformedLines > 0) {
    text += `\n\nIgnored ${params.malformedLines} malformed recall line${params.malformedLines === 1 ? "" : "s"}.`
  }

  if (params.recallMaxBytes <= 0 || Buffer.byteLength(text, "utf8") <= params.recallMaxBytes) {
    return text
  }

  const notice = "\n\n[universal_recall output truncated by recallMaxBytes]"
  const budget = Math.max(0, params.recallMaxBytes - Buffer.byteLength(notice, "utf8"))
  return truncateUtf8(text, budget) + notice
}

export function createUniversalRecallTool(params: {
  config: UniversalCaptureConfig
  context: OpenClawPluginToolContext
}) {
  return {
    name: "universal_recall",
    label: "Universal Recall",
    description:
      "Recall recent request-response turns captured for the current OpenClaw session.",
    parameters: {},
    execute: async () => {
      const ctx = params.context
      if (!ctx.workspaceDir) {
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: "universal_recall is unavailable because workspaceDir is unavailable.",
            },
          ],
        }
      }
      if (!ctx.sessionKey) {
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: "universal_recall is unavailable because sessionKey is unavailable.",
            },
          ],
        }
      }

      const filePath = resolveRecallFilePath({
        workspaceDir: ctx.workspaceDir,
        recallFolder: params.config.recallFolder,
        sessionKey: ctx.sessionKey,
      })
      const recalled = await readRecallFile(filePath)
      const entries = recalled.entries.slice(-params.config.recallTurns)

      return {
        details: {},
        content: [
          {
            type: "text" as const,
            text: renderRecallToolOutput({
              entries,
              malformedLines: recalled.malformedLines,
              recallMaxBytes: params.config.recallMaxBytes,
            }),
          },
        ],
      }
    },
  }
}
