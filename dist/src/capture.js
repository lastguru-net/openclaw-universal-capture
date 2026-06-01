import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
function dateFromParts(parts) {
    const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
    return `${value("year")}-${value("month")}-${value("day")}`;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function rolloverMinutes(rolloverTime) {
    const [hour = "0", minute = "0"] = rolloverTime.split(":");
    return Number(hour) * 60 + Number(minute);
}
function formatInTimezone(timestamp, timezone, rolloverTime) {
    const date = typeof timestamp === "number" || typeof timestamp === "string"
        ? new Date(timestamp)
        : new Date();
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(safeDate);
    const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
    const time = `${value("hour")}:${value("minute")}`;
    const localMinutes = Number(value("hour")) * 60 + Number(value("minute"));
    const captureDate = localMinutes < rolloverMinutes(rolloverTime)
        ? dateFromParts(new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(new Date(safeDate.getTime() - 24 * 60 * 60 * 1000)))
        : dateFromParts(parts);
    return {
        date: captureDate,
        time,
    };
}
function extractTextPart(value) {
    const part = asRecord(value);
    if (!part)
        return undefined;
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string") {
        return part.text;
    }
    return undefined;
}
export function extractMessageText(message) {
    const record = asRecord(message);
    if (!record)
        return "";
    const content = record.content;
    if (typeof content === "string")
        return content.trim();
    if (!Array.isArray(content))
        return "";
    return content
        .map(extractTextPart)
        .filter((text) => typeof text === "string" && text.length > 0)
        .join("\n")
        .trim();
}
function messageRole(message) {
    const record = asRecord(message);
    return typeof record?.role === "string" ? record.role : undefined;
}
function messageTimestamp(message) {
    const record = asRecord(message);
    const timestamp = record?.timestamp;
    return typeof timestamp === "number" || typeof timestamp === "string"
        ? timestamp
        : undefined;
}
function findCorrespondingUserText(messages, assistantIndex) {
    for (let index = assistantIndex - 1; index >= 0; index--) {
        if (messageRole(messages[index]) !== "user")
            continue;
        const text = extractMessageText(messages[index]);
        if (text)
            return text;
    }
    return "";
}
export function selectCaptureEntries(params) {
    const entries = [];
    const start = Math.max(0, Math.min(params.prePromptMessageCount, params.messages.length));
    for (let index = start; index < params.messages.length; index++) {
        const message = params.messages[index];
        if (messageRole(message) !== "assistant")
            continue;
        const assistantText = extractMessageText(message);
        if (!assistantText)
            continue;
        if (params.skipNoReply && assistantText.trim() === "NO_REPLY")
            continue;
        const userText = findCorrespondingUserText(params.messages, index);
        if (!userText)
            continue;
        const dateParts = formatInTimezone(messageTimestamp(message), params.timezone, params.rolloverTime);
        entries.push({
            ...dateParts,
            userText,
            assistantText,
        });
    }
    return entries;
}
export function resolveCaptureFileTarget(params) {
    const fileName = `conversations-${params.date}.md`;
    const filePath = resolve(params.workspaceDir, params.folder, fileName);
    const title = basename(fileName, ".md");
    const permalinkFolder = params.folder.replace(/^\/+|\/+$/g, "");
    const permalink = permalinkFolder ? `${permalinkFolder}/${title}` : title;
    return {
        date: params.date,
        fileName,
        filePath,
        permalink,
        title,
    };
}
export function renderInitialFile(target) {
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
    ].join("\n");
}
export function renderCaptureEntry(entry) {
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
    ].join("\n");
}
async function ensureCaptureFile(target) {
    await mkdir(dirname(target.filePath), { recursive: true });
    try {
        await readFile(target.filePath, "utf8");
    }
    catch (error) {
        const code = asRecord(error)?.code;
        if (code !== "ENOENT")
            throw error;
        await writeFile(target.filePath, renderInitialFile(target), "utf8");
    }
}
export async function appendCaptureEntries(params) {
    const grouped = new Map();
    for (const entry of params.entries) {
        const existing = grouped.get(entry.date);
        if (existing)
            existing.push(entry);
        else
            grouped.set(entry.date, [entry]);
    }
    let written = 0;
    for (const [date, entries] of grouped) {
        const target = resolveCaptureFileTarget({
            workspaceDir: params.workspaceDir,
            folder: params.config.folder,
            date,
        });
        await ensureCaptureFile(target);
        await appendFile(target.filePath, entries.map(renderCaptureEntry).join(""), "utf8");
        written += entries.length;
    }
    return written;
}
