import type {
  AgentMessage,
  HarnessContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime"
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core"
import { type PluginLogger } from "openclaw/plugin-sdk/plugin-entry"

import {
  appendCaptureEntries,
  selectCaptureEntries,
} from "./capture.js"
import type { UniversalCaptureConfig } from "./config.js"
import { writeRecallEntries } from "./recall.js"

export class UniversalCaptureContextEngine implements HarnessContextEngine {
  readonly info = {
    id: "openclaw-universal-capture",
    name: "OpenClaw Universal Capture",
    version: "0.7.0",
    acceptedHostParams: ["sessionKey"] as string[],
    transcriptSemantics: {
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    },
    ownsCompaction: false,
  } as const

  constructor(
    private readonly params: {
      config: UniversalCaptureConfig
      workspaceDir?: string
      logger?: PluginLogger
    },
  ) {}

  async bootstrap(): Promise<{ bootstrapped: boolean; reason?: string }> {
    this.requireWorkspaceDir()
    return { bootstrapped: true }
  }

  async ingest(): Promise<{ ingested: boolean }> {
    return { ingested: false }
  }

  async assemble(params: {
    messages: AgentMessage[]
  }): Promise<{
    messages: AgentMessage[]
    estimatedTokens: number
    contextProjection: {
      mode: "thread_bootstrap"
      epoch: string
      fingerprint: string
    }
  }> {
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
    }
  }

  async commitTurn(
    params: Parameters<NonNullable<HarnessContextEngine["commitTurn"]>>[0],
  ): Promise<{ status: "committed" | "duplicate" }> {
    const workspaceDir = this.requireWorkspaceDir()
    const sessionKey = params.admission.sessionKey
    const entries = selectCaptureEntries({
      messages: params.messages,
      prePromptMessageCount: 0,
      timezone: this.params.config.timezone,
      rolloverTime: this.params.config.rolloverTime,
      skipNoReply: this.params.config.skipNoReply,
      includeMessageMetadata: this.params.config.includeMessageMetadata,
      stripUntrustedMetadata: this.params.config.stripUntrustedMetadata,
      agents: this.params.config.agents,
      surfaces: this.params.config.surfaces,
      channels: this.params.config.channels,
      sessionKey,
    })

    const recall =
      this.params.config.recallTurns > 0 && entries.length > 0
        ? await writeRecallEntries({
            workspaceDir,
            config: this.params.config,
            sessionId: params.sessionId,
            sessionKey,
            entries,
            advancementKey: params.advancementKey,
          })
        : { written: 0, malformedLines: 0 }
    if (recall.malformedLines > 0) {
      this.params.logger?.warn(
        `openclaw-universal-capture ignored ${recall.malformedLines} malformed recall line${recall.malformedLines === 1 ? "" : "s"}`,
      )
    }
    const written =
      entries.length > 0
        ? await appendCaptureEntries({
            workspaceDir,
            config: this.params.config,
            entries,
          })
        : 0
    this.params.logger?.debug?.(
      `openclaw-universal-capture appended ${written} conversation entr${written === 1 ? "y" : "ies"} and ${recall.written} recall entr${recall.written === 1 ? "y" : "ies"}`,
    )
    return { status: "committed" }
  }

  async compact(
    params: Parameters<HarnessContextEngine["compact"]>[0],
  ): Promise<Awaited<ReturnType<HarnessContextEngine["compact"]>>> {
    return delegateCompactionToRuntime(params)
  }

  private requireWorkspaceDir(): string {
    if (!this.params.workspaceDir) {
      throw new Error(
        "openclaw-universal-capture requires workspaceDir for durable capture",
      )
    }
    return this.params.workspaceDir
  }
}
