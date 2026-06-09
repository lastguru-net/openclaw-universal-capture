import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-runtime";
import type { ConversationCaptureEntry } from "./capture.js";
import type { UniversalCaptureConfig } from "./config.js";
export type RecallEntry = {
    timestamp: string;
    sessionId?: string;
    sessionKey: string;
    senderUsername?: string;
    userText: string;
    assistantText: string;
};
type RecallReadResult = {
    entries: RecallEntry[];
    malformedLines: number;
};
export declare function resolveRecallFilePath(params: {
    workspaceDir: string;
    recallFolder: string;
    sessionKey: string;
}): string;
export declare function parseRecallLines(text: string): RecallReadResult;
export declare function writeRecallEntries(params: {
    workspaceDir: string;
    config: UniversalCaptureConfig;
    sessionId?: string;
    sessionKey: string;
    entries: ConversationCaptureEntry[];
}): Promise<{
    written: number;
    malformedLines: number;
}>;
export declare function renderRecallToolOutput(params: {
    entries: RecallEntry[];
    malformedLines: number;
    recallMaxBytes: number;
}): string;
export declare function createUniversalRecallTool(params: {
    config: UniversalCaptureConfig;
    context: OpenClawPluginToolContext;
}): {
    name: string;
    label: string;
    description: string;
    parameters: {};
    execute: () => Promise<{
        details: {};
        content: {
            type: "text";
            text: string;
        }[];
    }>;
};
export {};
