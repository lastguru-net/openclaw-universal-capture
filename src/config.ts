import { isAbsolute, normalize } from "node:path"

export type UniversalCaptureConfig = {
  folder: string
  timezone: string
  skipNoReply: boolean
}

const DEFAULT_FOLDER = "conversations"
const DEFAULT_TIMEZONE = "UTC"

const ALLOWED_KEYS = new Set(["folder", "timezone", "skipNoReply"])

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
      : DEFAULT_TIMEZONE
  assertValidTimezone(timezone)

  return {
    folder: normalizeFolder(config.folder),
    timezone,
    skipNoReply:
      typeof config.skipNoReply === "boolean" ? config.skipNoReply : false,
  }
}
