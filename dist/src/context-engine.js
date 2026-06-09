import { delegateCompactionToRuntime, } from "openclaw/plugin-sdk";
import { appendCaptureEntries, selectCaptureEntries, } from "./capture.js";
import { writeRecallEntries } from "./recall.js";
export class UniversalCaptureContextEngine {
    params;
    info = {
        id: "openclaw-universal-capture",
        name: "OpenClaw Universal Capture",
        version: "0.5.0",
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
                // Keep this stable across capture-only releases. Change it only when
                // assemble() projects semantically different bootstrap context.
                epoch: "v0",
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
            rolloverTime: this.params.config.rolloverTime,
            skipNoReply: this.params.config.skipNoReply,
            includeMessageMetadata: this.params.config.includeMessageMetadata,
            stripUntrustedMetadata: this.params.config.stripUntrustedMetadata,
            agents: this.params.config.agents,
            surfaces: this.params.config.surfaces,
            channels: this.params.config.channels,
            sessionKey: params.sessionKey,
        });
        if (entries.length === 0)
            return;
        const written = await appendCaptureEntries({
            workspaceDir,
            config: this.params.config,
            entries,
        });
        if (this.params.config.recallTurns > 0 && params.sessionKey) {
            try {
                const recall = await writeRecallEntries({
                    workspaceDir,
                    config: this.params.config,
                    sessionId: params.sessionId,
                    sessionKey: params.sessionKey,
                    entries,
                });
                if (recall.malformedLines > 0) {
                    this.params.logger?.warn(`openclaw-universal-capture ignored ${recall.malformedLines} malformed recall line${recall.malformedLines === 1 ? "" : "s"}`);
                }
            }
            catch (error) {
                this.params.logger?.warn(`openclaw-universal-capture skipped recall write: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.params.logger?.debug?.(`openclaw-universal-capture appended ${written} conversation entr${written === 1 ? "y" : "ies"}`);
    }
    async compact(params) {
        return delegateCompactionToRuntime(params);
    }
}
