import type { AgentMessage, HarnessContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { type PluginLogger, type CompactResult } from "openclaw/plugin-sdk";
import type { UniversalCaptureConfig } from "./config.js";
export declare class UniversalCaptureContextEngine implements HarnessContextEngine {
    private readonly params;
    readonly info: {
        readonly id: "openclaw-universal-capture";
        readonly name: "OpenClaw Universal Capture";
        readonly version: "0.1.0";
        readonly ownsCompaction: false;
    };
    constructor(params: {
        config: UniversalCaptureConfig;
        workspaceDir?: string;
        logger?: PluginLogger;
    });
    bootstrap(): Promise<{
        bootstrapped: boolean;
        reason?: string;
    }>;
    ingest(): Promise<{
        ingested: boolean;
    }>;
    assemble(params: {
        messages: AgentMessage[];
    }): Promise<{
        messages: AgentMessage[];
        estimatedTokens: number;
        contextProjection: {
            mode: "thread_bootstrap";
            epoch: string;
            fingerprint: string;
        };
    }>;
    afterTurn(params: {
        messages: AgentMessage[];
        prePromptMessageCount: number;
    }): Promise<void>;
    compact(params: Parameters<HarnessContextEngine["compact"]>[0]): Promise<CompactResult>;
}
