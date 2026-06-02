import { isAbsolute, normalize } from "node:path"

export type UniversalCaptureConfig = {
  folder: string
  timezone: string
  rolloverTime: string
  skipNoReply: boolean
  includeMessageMetadata: boolean
  stripUntrustedMetadata: boolean
}

const DEFAULT_FOLDER = "conversations"
const DEFAULT_ROLLOVER_TIME = "04:00"

const ALLOWED_KEYS = new Set([
  "folder",
  "timezone",
  "rolloverTime",
  "skipNoReply",
  "includeMessageMetadata",
  "stripUntrustedMetadata",
])

function assertAllowedKeys(config: Record<string, unknown>): void {
  const unknown = Object.keys(config).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `openclaw-universal-capture config has unknown keys: ${unknown.join(", ")}`,
    )
  }
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date())
  } catch {
    throw new Error(`Invalid timezone for openclaw-universal-capture: ${timezone}`)
  }
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

function normalizeRolloverTime(value: unknown): string {
  const rolloverTime =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : DEFAULT_ROLLOVER_TIME
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(rolloverTime)
  if (!match) {
    throw new Error(
      "openclaw-universal-capture rolloverTime must use HH:MM in 24-hour time",
    )
  }
  return rolloverTime
}

function normalizeFolder(value: unknown): string {
  const folder =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : DEFAULT_FOLDER
  if (isAbsolute(folder)) {
    throw new Error("openclaw-universal-capture folder must be workspace-relative")
  }

  const normalized = normalize(folder).replace(/\\/g, "/")
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error("openclaw-universal-capture folder must stay inside the workspace")
  }
  return normalized.replace(/^\.\/+/, "").replace(/\/+$/, "")
}

export function parseConfig(raw: unknown): UniversalCaptureConfig {
  const config =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  assertAllowedKeys(config)

  const timezone =
    typeof config.timezone === "string" && config.timezone.trim().length > 0
      ? config.timezone.trim()
      : defaultTimezone()
  assertValidTimezone(timezone)

  return {
    folder: normalizeFolder(config.folder),
    timezone,
    rolloverTime: normalizeRolloverTime(config.rolloverTime),
    skipNoReply:
      typeof config.skipNoReply === "boolean" ? config.skipNoReply : false,
    includeMessageMetadata:
      typeof config.includeMessageMetadata === "boolean"
        ? config.includeMessageMetadata
        : false,
    stripUntrustedMetadata:
      typeof config.stripUntrustedMetadata === "boolean"
        ? config.stripUntrustedMetadata
        : true,
  }
}
