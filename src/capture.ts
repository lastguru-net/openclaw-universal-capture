import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import type { UniversalCaptureConfig } from "./config.js"

export type ConversationCaptureEntry = {
  date: string
  time: string
  userText: string
  assistantText: string
}

export type CaptureFileTarget = {
  date: string
  fileName: string
  filePath: string
  permalink: string
  title: string
}

type DateParts = {
  date: string
  time: string
}

type RecordLike = Record<string, unknown>

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : undefined
}

function formatInTimezone(timestamp: number | string | undefined, timezone: string): DateParts {
  const date =
    typeof timestamp === "number" || typeof timestamp === "string"
      ? new Date(timestamp)
      : new Date()
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(safeDate)

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  }
}

function extractTextPart(value: unknown): string | undefined {
  const part = asRecord(value)
  if (!part) return undefined
  if (
    (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
    typeof part.text === "string"
  ) {
    return part.text
  }
  return undefined
}

export function extractMessageText(message: unknown): string {
  const record = asRecord(message)
  if (!record) return ""

  const content = record.content
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""

  return content
    .map(extractTextPart)
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n")
    .trim()
}

function messageRole(message: unknown): string | undefined {
  const record = asRecord(message)
  return typeof record?.role === "string" ? record.role : undefined
}

function messageTimestamp(message: unknown): number | string | undefined {
  const record = asRecord(message)
  const timestamp = record?.timestamp
  return typeof timestamp === "number" || typeof timestamp === "string"
    ? timestamp
    : undefined
}

function findCorrespondingUserText(messages: AgentMessage[], assistantIndex: number): string {
  for (let index = assistantIndex - 1; index >= 0; index--) {
    if (messageRole(messages[index]) !== "user") continue
    const text = extractMessageText(messages[index])
    if (text) return text
  }
  return ""
}

export function selectCaptureEntries(params: {
  messages: AgentMessage[]
  prePromptMessageCount: number
  timezone: string
  skipNoReply: boolean
}): ConversationCaptureEntry[] {
  const entries: ConversationCaptureEntry[] = []
  const start = Math.max(0, Math.min(params.prePromptMessageCount, params.messages.length))

  for (let index = start; index < params.messages.length; index++) {
    const message = params.messages[index]
    if (messageRole(message) !== "assistant") continue

    const assistantText = extractMessageText(message)
    if (!assistantText) continue
    if (params.skipNoReply && assistantText.trim() === "NO_REPLY") continue

    const userText = findCorrespondingUserText(params.messages, index)
    if (!userText) continue

    const dateParts = formatInTimezone(messageTimestamp(message), params.timezone)
    entries.push({
      ...dateParts,
      userText,
      assistantText,
    })
  }

  return entries
}

export function resolveCaptureFileTarget(params: {
  workspaceDir: string
  folder: string
  date: string
}): CaptureFileTarget {
  const fileName = `conversations-${params.date}.md`
  const filePath = resolve(params.workspaceDir, params.folder, fileName)
  const title = basename(fileName, ".md")
  const permalinkFolder = params.folder.replace(/^\/+|\/+$/g, "")
  const permalink = permalinkFolder ? `${permalinkFolder}/${title}` : title

  return {
    date: params.date,
    fileName,
    filePath,
    permalink,
    title,
  }
}

export function renderInitialFile(target: CaptureFileTarget): string {
  return [
    "---",
    `title: ${target.title}`,
    "type: Conversation",
    `permalink: ${target.permalink}`,
    `date: ${target.date}`,
    "---",
    "",
    `# Conversations ${target.date}`,
    "",
  ].join("\n")
}

export function renderCaptureEntry(entry: ConversationCaptureEntry): string {
  return [
    `### ${entry.time}`,
    "",
    "**User:**",
    entry.userText.trimEnd(),
    "",
    "**Assistant:**",
    entry.assistantText.trimEnd(),
    "",
    "---",
    "",
  ].join("\n")
}

async function ensureCaptureFile(target: CaptureFileTarget): Promise<void> {
  await mkdir(dirname(target.filePath), { recursive: true })
  try {
    await readFile(target.filePath, "utf8")
  } catch (error) {
    const code = asRecord(error)?.code
    if (code !== "ENOENT") throw error
    await writeFile(target.filePath, renderInitialFile(target), "utf8")
  }
}

export async function appendCaptureEntries(params: {
  workspaceDir: string
  config: UniversalCaptureConfig
  entries: ConversationCaptureEntry[]
}): Promise<number> {
  const grouped = new Map<string, ConversationCaptureEntry[]>()
  for (const entry of params.entries) {
    const existing = grouped.get(entry.date)
    if (existing) existing.push(entry)
    else grouped.set(entry.date, [entry])
  }

  let written = 0
  for (const [date, entries] of grouped) {
    const target = resolveCaptureFileTarget({
      workspaceDir: params.workspaceDir,
      folder: params.config.folder,
      date,
    })
    await ensureCaptureFile(target)
    await appendFile(target.filePath, entries.map(renderCaptureEntry).join(""), "utf8")
    written += entries.length
  }
  return written
}
