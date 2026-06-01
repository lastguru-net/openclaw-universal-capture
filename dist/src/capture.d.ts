import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { UniversalCaptureConfig } from "./config.js";
export type ConversationCaptureEntry = {
    date: string;
    time: string;
    userText: string;
    assistantText: string;
};
export type CaptureFileTarget = {
    date: string;
    fileName: string;
    filePath: string;
    permalink: string;
    title: string;
};
export declare function extractMessageText(message: unknown): string;
export declare function selectCaptureEntries(params: {
    messages: AgentMessage[];
    prePromptMessageCount: number;
    timezone: string;
    rolloverTime: string;
    skipNoReply: boolean;
}): ConversationCaptureEntry[];
export declare function resolveCaptureFileTarget(params: {
    workspaceDir: string;
    folder: string;
    date: string;
}): CaptureFileTarget;
export declare function renderInitialFile(target: CaptureFileTarget): string;
export declare function renderCaptureEntry(entry: ConversationCaptureEntry): string;
export declare function appendCaptureEntries(params: {
    workspaceDir: string;
    config: UniversalCaptureConfig;
    entries: ConversationCaptureEntry[];
}): Promise<number>;
