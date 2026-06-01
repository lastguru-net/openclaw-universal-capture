import { isAbsolute, normalize } from "node:path";
const DEFAULT_FOLDER = "conversations";
const DEFAULT_ROLLOVER_TIME = "04:00";
const ALLOWED_KEYS = new Set(["folder", "timezone", "rolloverTime", "skipNoReply"]);
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
function defaultTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
function normalizeRolloverTime(value) {
    const rolloverTime = typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : DEFAULT_ROLLOVER_TIME;
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(rolloverTime);
    if (!match) {
        throw new Error("openclaw-universal-capture rolloverTime must use HH:MM in 24-hour time");
    }
    return rolloverTime;
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
        : defaultTimezone();
    assertValidTimezone(timezone);
    return {
        folder: normalizeFolder(config.folder),
        timezone,
        rolloverTime: normalizeRolloverTime(config.rolloverTime),
        skipNoReply: typeof config.skipNoReply === "boolean" ? config.skipNoReply : false,
    };
}
