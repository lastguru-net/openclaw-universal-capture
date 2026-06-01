import { isAbsolute, normalize } from "node:path";
const DEFAULT_FOLDER = "conversations";
const DEFAULT_TIMEZONE = "UTC";
const ALLOWED_KEYS = new Set(["folder", "timezone", "skipNoReply"]);
function assertAllowedKeys(config) {
    const unknown = Object.keys(config).filter((key) => !ALLOWED_KEYS.has(key));
    if (unknown.length > 0) {
        throw new Error(`openclaw-universal-capture config has unknown keys: ${unknown.join(", ")}`);
    }
}
function assertValidTimezone(timezone) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    }
    catch {
        throw new Error(`Invalid timezone for openclaw-universal-capture: ${timezone}`);
    }
}
function normalizeFolder(value) {
    const folder = typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : DEFAULT_FOLDER;
    if (isAbsolute(folder)) {
        throw new Error("openclaw-universal-capture folder must be workspace-relative");
    }
    const normalized = normalize(folder).replace(/\\/g, "/");
    if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
        throw new Error("openclaw-universal-capture folder must stay inside the workspace");
    }
    return normalized.replace(/^\.\/+/, "").replace(/\/+$/, "");
}
export function parseConfig(raw) {
    const config = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : {};
    assertAllowedKeys(config);
    const timezone = typeof config.timezone === "string" && config.timezone.trim().length > 0
        ? config.timezone.trim()
        : DEFAULT_TIMEZONE;
    assertValidTimezone(timezone);
    return {
        folder: normalizeFolder(config.folder),
        timezone,
        skipNoReply: typeof config.skipNoReply === "boolean" ? config.skipNoReply : false,
    };
}
