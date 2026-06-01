import { delegateCompactionToRuntime, } from "openclaw/plugin-sdk";
import { appendCaptureEntries, selectCaptureEntries, } from "./capture.js";
export class UniversalCaptureContextEngine {
    params;
    info = {
        id: "openclaw-universal-capture",
        name: "OpenClaw Universal Capture",
        version: "0.1.0",
        ownsCompaction: false,
    };
    constructor(params) {
        this.params = params;
    }
    async bootstrap() {
        return { bootstrapped: true };
    }
    async ingest() {
        return { ingested: false };
    }
    async assemble(params) {
        return {
            messages: params.messages,
            estimatedTokens: 0,
            contextProjection: {
                mode: "thread_bootstrap",
                epoch: "v0.1",
                fingerprint: "append-only-md-capture",
            },
        };
    }
    async afterTurn(params) {
        const workspaceDir = this.params.workspaceDir;
        if (!workspaceDir) {
            this.params.logger?.warn("openclaw-universal-capture skipped afterTurn because workspaceDir is unavailable");
            return;
        }
        const entries = selectCaptureEntries({
            messages: params.messages,
            prePromptMessageCount: params.prePromptMessageCount,
            timezone: this.params.config.timezone,
            skipNoReply: this.params.config.skipNoReply,
        });
        if (entries.length === 0)
            return;
        const written = await appendCaptureEntries({
            workspaceDir,
            config: this.params.config,
            entries,
        });
        this.params.logger?.debug?.(`openclaw-universal-capture appended ${written} conversation entr${written === 1 ? "y" : "ies"}`);
    }
    async compact(params) {
        return delegateCompactionToRuntime(params);
    }
}
