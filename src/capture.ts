import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import type { CaptureFilter, UniversalCaptureConfig } from "./config.js"

export type ConversationCaptureEntry = {
  date: string
  time: string
  metadata?: ConversationCaptureMetadata
  userText: string
  assistantText: string
}

export type ConversationCaptureMetadata = {
  agent?: string
  surface?: string
  channel?: string
  senderUsername?: string
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

type SessionKeyParts = {
  agent?: string
  surface?: string
  channel?: string
  channelId?: string
}

function dateFromParts(parts: Intl.DateTimeFormatPart[]): string {
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${value("year")}-${value("month")}-${value("day")}`
}

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : undefined
}

function rolloverMinutes(rolloverTime: string): number {
  const [hour = "0", minute = "0"] = rolloverTime.split(":")
  return Number(hour) * 60 + Number(minute)
}

function formatInTimezone(
  timestamp: number | string | undefined,
  timezone: string,
  rolloverTime: string,
): DateParts {
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
  const time = `${value("hour")}:${value("minute")}`
  const localMinutes = Number(value("hour")) * 60 + Number(value("minute"))
  const captureDate =
    localMinutes < rolloverMinutes(rolloverTime)
      ? dateFromParts(
          new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).formatToParts(new Date(safeDate.getTime() - 24 * 60 * 60 * 1000)),
        )
      : dateFromParts(parts)

  return {
    date: captureDate,
    time,
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

function messageSenderUsername(message: unknown): string | undefined {
  const record = asRecord(message)
  const senderUsername = record?.senderUsername
  return typeof senderUsername === "string" && senderUsername.trim().length > 0
    ? senderUsername.trim()
    : undefined
}

function parseSessionKey(sessionKey: string | undefined): SessionKeyParts {
  if (!sessionKey) return {}
  const parts = sessionKey.split(":")
  if (parts[0] !== "agent" || parts.length < 3) return {}

  const parsed: SessionKeyParts = {}
  if (parts[1]) parsed.agent = parts[1]
  if (parts[2]) parsed.surface = parts[2]
  if (parts.length > 3) {
    const channel = parts.slice(3).join(":")
    if (channel) parsed.channel = channel
    const channelId = parts.at(-1)
    if (channelId) parsed.channelId = channelId
  }
  return parsed
}

function buildCaptureMetadata(params: {
  sessionKey?: string
  userMessage: AgentMessage
}): ConversationCaptureMetadata | undefined {
  const session = parseSessionKey(params.sessionKey)
  const metadata: ConversationCaptureMetadata = {
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.surface ? { surface: session.surface } : {}),
    ...(session.channel ? { channel: session.channel } : {}),
  }
  const senderUsername = messageSenderUsername(params.userMessage)
  if (senderUsername) metadata.senderUsername = senderUsername

  return Object.keys(metadata).length > 0 ? metadata : undefined
}

function filterAllows(filter: CaptureFilter, value: string | undefined): boolean {
  if (filter.mode === "all") return true
  if (!value) return filter.mode === "exclude"

  const listed = filter.values.has(value)
  return filter.mode === "include" ? listed : !listed
}

function sessionKeyPassesFilters(
  sessionKey: string | undefined,
  config: Pick<UniversalCaptureConfig, "agents" | "surfaces" | "channels">,
): boolean {
  const session = parseSessionKey(sessionKey)
  return (
    filterAllows(config.agents, session.agent) &&
    filterAllows(config.surfaces, session.surface) &&
    filterAllows(config.channels, session.channelId)
  )
}

function findCorrespondingUser(messages: AgentMessage[], assistantIndex: number): {
  message: AgentMessage
  text: string
} | undefined {
  for (let index = assistantIndex - 1; index >= 0; index--) {
    if (messageRole(messages[index]) !== "user") continue
    const text = extractMessageText(messages[index])
    if (text) return { message: messages[index], text }
  }
  return undefined
}

const CONVERSATION_INFO_HEADER = "Conversation info (untrusted metadata):\n"
const SENDER_HEADER = "Sender (untrusted metadata):\n"
const JSON_FENCE_START = "```json\n"

function findJsonFenceEnd(text: string, start: number): number | undefined {
  let searchStart = start
  while (searchStart < text.length) {
    const fenceStart = text.indexOf("\n```", searchStart)
    if (fenceStart < 0) return undefined

    const fenceEnd = fenceStart + "\n```".length
    const next = text[fenceEnd]
    if (next === undefined || next === "\n") return fenceEnd
    searchStart = fenceEnd
  }
  return undefined
}

function consumeLeadingMetadataBlock(
  text: string,
  start: number,
  header: string,
): number | undefined {
  if (!text.startsWith(header, start)) return undefined

  const fenceStart = start + header.length
  if (!text.startsWith(JSON_FENCE_START, fenceStart)) return undefined

  const bodyStart = fenceStart + JSON_FENCE_START.length
  const fenceEnd = findJsonFenceEnd(text, bodyStart)
  if (fenceEnd === undefined) return undefined

  let next = fenceEnd
  if (text.startsWith("\n\n", next)) next += 2
  else if (text.startsWith("\n", next)) next += 1
  return next
}

export function stripLeadingUntrustedMetadata(text: string): string {
  const afterConversationInfo = consumeLeadingMetadataBlock(
    text,
    0,
    CONVERSATION_INFO_HEADER,
  )
  if (afterConversationInfo === undefined) return text

  const afterSender = consumeLeadingMetadataBlock(
    text,
    afterConversationInfo,
    SENDER_HEADER,
  )
  return text.slice(afterSender ?? afterConversationInfo)
}

export function selectCaptureEntries(params: {
  messages: AgentMessage[]
  prePromptMessageCount: number
  timezone: string
  rolloverTime: string
  skipNoReply: boolean
  includeMessageMetadata: boolean
  stripUntrustedMetadata: boolean
  agents: CaptureFilter
  surfaces: CaptureFilter
  channels: CaptureFilter
  sessionKey?: string
}): ConversationCaptureEntry[] {
  const entries: ConversationCaptureEntry[] = []
  if (!sessionKeyPassesFilters(params.sessionKey, params)) return entries

  const start = Math.max(0, Math.min(params.prePromptMessageCount, params.messages.length))

  for (let index = start; index < params.messages.length; index++) {
    const message = params.messages[index]
    if (messageRole(message) !== "assistant") continue

    const assistantText = extractMessageText(message)
    if (!assistantText) continue
    if (params.skipNoReply && assistantText.trim() === "NO_REPLY") continue

    const user = findCorrespondingUser(params.messages, index)
    if (!user) continue

    const dateParts = formatInTimezone(
      messageTimestamp(message),
      params.timezone,
      params.rolloverTime,
    )
    entries.push({
      ...dateParts,
      ...(params.includeMessageMetadata
        ? {
            metadata: buildCaptureMetadata({
              sessionKey: params.sessionKey,
              userMessage: user.message,
            }),
          }
        : {}),
      userText: params.stripUntrustedMetadata
        ? stripLeadingUntrustedMetadata(user.text)
        : user.text,
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
  const metadataLines = renderMetadataLines(entry.metadata)
  return [
    `### ${entry.time}`,
    ...metadataLines,
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

function renderMetadataLines(
  metadata: ConversationCaptureMetadata | undefined,
): string[] {
  if (!metadata) return []

  const lines: string[] = []
  if (metadata.agent) lines.push(`Agent: ${metadata.agent}`)
  if (metadata.surface) lines.push(`Surface: ${metadata.surface}`)
  if (metadata.channel) lines.push(`Channel: ${metadata.channel}`)
  if (metadata.senderUsername) lines.push(`Sender: ${metadata.senderUsername}`)
  return lines
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
