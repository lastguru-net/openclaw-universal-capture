import { isAbsolute, normalize } from "node:path";
const DEFAULT_FOLDER = "conversations";
const DEFAULT_RECALL_FOLDER = "recall";
const DEFAULT_ROLLOVER_TIME = "04:00";
const ALLOWED_KEYS = new Set([
    "folder",
    "recallFolder",
    "recallTurns",
    "recallMaxBytes",
    "timezone",
    "rolloverTime",
    "skipNoReply",
    "includeMessageMetadata",
    "stripUntrustedMetadata",
    "agents",
    "surfaces",
    "channels",
]);
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
function normalizeNonNegativeInteger(name, value) {
    if (value === undefined || value === null)
        return 0;
    if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
        throw new Error(`openclaw-universal-capture ${name} must be a non-negative integer`);
    }
    return value;
}
function normalizeFilter(name, value) {
    if (value === undefined || value === null) {
        return { mode: "all", values: new Set() };
    }
    if (typeof value !== "string") {
        throw new Error(`openclaw-universal-capture ${name} must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed === "*") {
        return { mode: "all", values: new Set() };
    }
    const negated = trimmed.startsWith("!");
    const listText = negated ? trimmed.slice(1).trim() : trimmed;
    if (!listText || listText === "*") {
        return { mode: "all", values: new Set() };
    }
    const values = new Set(listText
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0));
    if (values.size === 0) {
        return { mode: "all", values: new Set() };
    }
    return {
        mode: negated ? "exclude" : "include",
        values,
    };
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
        recallFolder: normalizeFolder(config.recallFolder ?? DEFAULT_RECALL_FOLDER),
        recallTurns: normalizeNonNegativeInteger("recallTurns", config.recallTurns),
        recallMaxBytes: normalizeNonNegativeInteger("recallMaxBytes", config.recallMaxBytes),
        timezone,
        rolloverTime: normalizeRolloverTime(config.rolloverTime),
        skipNoReply: typeof config.skipNoReply === "boolean" ? config.skipNoReply : false,
        includeMessageMetadata: typeof config.includeMessageMetadata === "boolean"
            ? config.includeMessageMetadata
            : false,
        stripUntrustedMetadata: typeof config.stripUntrustedMetadata === "boolean"
            ? config.stripUntrustedMetadata
            : true,
        agents: normalizeFilter("agents", config.agents),
        surfaces: normalizeFilter("surfaces", config.surfaces),
        channels: normalizeFilter("channels", config.channels),
    };
}
