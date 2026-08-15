import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry"

import { atomicWriteText, withFileLock } from "./atomic-file.js"
import type { ConversationCaptureEntry } from "./capture.js"
import type { UniversalCaptureConfig } from "./config.js"

export type RecallEntry = {
  advancementKey?: string
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

export type UniversalRecallToolParams = {
  maxTurns?: number
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
    ...(asOptionalString(value.advancementKey)
      ? { advancementKey: asOptionalString(value.advancementKey) }
      : {}),
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
  config: Pick<
    UniversalCaptureConfig,
    "recallFolder" | "recallTurns" | "recallMaxBytes"
  >
  sessionId?: string
  sessionKey: string
  entries: ConversationCaptureEntry[]
  advancementKey?: string
}): Promise<{ written: number; malformedLines: number }> {
  if (params.config.recallTurns <= 0 || params.entries.length === 0) {
    return { written: 0, malformedLines: 0 }
  }

  const filePath = resolveRecallFilePath({
    workspaceDir: params.workspaceDir,
    recallFolder: params.config.recallFolder,
    sessionKey: params.sessionKey,
  })
  return await withFileLock(filePath, async () => {
    const existing = await readRecallFile(filePath)
    if (
      params.advancementKey &&
      existing.entries.some((entry) => entry.advancementKey === params.advancementKey)
    ) {
      return { written: 0, malformedLines: existing.malformedLines }
    }

    const nextEntries = pruneRecallEntries({
      entries: [
        ...existing.entries,
        ...params.entries.map((entry) => ({
          ...(params.advancementKey
            ? { advancementKey: params.advancementKey }
            : {}),
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

    await atomicWriteText(filePath, serializeEntries(nextEntries))
    return { written: params.entries.length, malformedLines: existing.malformedLines }
  })
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
      : "No recalled turns found for this sessionKey."
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

export function resolveRecallToolMaxTurns(params: {
  rawParams: unknown
  defaultTurns: number
}): number {
  if (params.rawParams === undefined || params.rawParams === null) {
    return params.defaultTurns
  }
  if (!isRecord(params.rawParams)) {
    throw new Error("universal_recall parameters must be an object.")
  }

  const allowedKeys = new Set(["maxTurns"])
  const unknownKeys = Object.keys(params.rawParams).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(`universal_recall has unknown parameter(s): ${unknownKeys.join(", ")}.`)
  }

  const rawMaxTurns = params.rawParams.maxTurns
  if (rawMaxTurns === undefined || rawMaxTurns === 0) {
    return params.defaultTurns
  }
  if (typeof rawMaxTurns !== "number" || !Number.isInteger(rawMaxTurns) || rawMaxTurns < 0) {
    throw new Error("universal_recall maxTurns must be a non-negative integer.")
  }

  return Math.min(rawMaxTurns, params.defaultTurns)
}

export function createUniversalRecallTool(params: {
  config: UniversalCaptureConfig
  context: OpenClawPluginToolContext
}) {
  return {
    name: "universal_recall",
    label: "Universal Recall",
    description:
      "Recall recent request-response turns captured for the current OpenClaw sessionKey, such as the current channel-bound conversation. Optional maxTurns limits how many latest turns to return; 0 or omitted uses the configured default window.",
    parameters: {
      type: "object",
      properties: {
        maxTurns: {
          type: "integer",
          minimum: 0,
          description:
            "Maximum number of latest request-response turns to return. Use 0 or omit to return the configured default recall window.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, rawParams?: unknown) => {
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

      const maxTurns = resolveRecallToolMaxTurns({
        rawParams,
        defaultTurns: params.config.recallTurns,
      })
      const filePath = resolveRecallFilePath({
        workspaceDir: ctx.workspaceDir,
        recallFolder: params.config.recallFolder,
        sessionKey: ctx.sessionKey,
      })
      const recalled = await readRecallFile(filePath)
      const entries = maxTurns > 0 ? recalled.entries.slice(-maxTurns) : []

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
