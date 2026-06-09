import type {
  AgentMessage,
  HarnessContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime"
import {
  delegateCompactionToRuntime,
  type PluginLogger,
  type CompactResult,
} from "openclaw/plugin-sdk"

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
    version: "0.5.0",
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

  async afterTurn(params: {
    sessionId: string
    sessionKey?: string
    messages: AgentMessage[]
    prePromptMessageCount: number
  }): Promise<void> {
    const workspaceDir = this.params.workspaceDir
    if (!workspaceDir) {
      this.params.logger?.warn(
        "openclaw-universal-capture skipped afterTurn because workspaceDir is unavailable",
      )
      return
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
    })
    if (entries.length === 0) return

    const written = await appendCaptureEntries({
      workspaceDir,
      config: this.params.config,
      entries,
    })
    if (this.params.config.recallTurns > 0 && params.sessionKey) {
      try {
        const recall = await writeRecallEntries({
          workspaceDir,
          config: this.params.config,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          entries,
        })
        if (recall.malformedLines > 0) {
          this.params.logger?.warn(
            `openclaw-universal-capture ignored ${recall.malformedLines} malformed recall line${recall.malformedLines === 1 ? "" : "s"}`,
          )
        }
      } catch (error) {
        this.params.logger?.warn(
          `openclaw-universal-capture skipped recall write: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    this.params.logger?.debug?.(
      `openclaw-universal-capture appended ${written} conversation entr${written === 1 ? "y" : "ies"}`,
    )
  }

  async compact(
    params: Parameters<HarnessContextEngine["compact"]>[0],
  ): Promise<CompactResult> {
    return delegateCompactionToRuntime(params)
  }
}
