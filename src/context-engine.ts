import type {
  AgentMessage,
  HarnessContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime"
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core"
import {
  type PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry"

import {
  resolveTurnCaptureDate,
  selectCaptureEntries,
} from "./capture.js"
import { commitCaptureTurn } from "./commit.js"
import type { UniversalCaptureConfig } from "./config.js"

export class UniversalCaptureContextEngine implements HarnessContextEngine {
  readonly info = {
    id: "openclaw-universal-capture",
    name: "OpenClaw Universal Capture",
    version: "0.7.0",
    acceptedHostParams: [
      "sessionKey",
      "sessionTarget",
      "runtimeSettings",
      "runtimeContext",
    ] as string[],
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
    if (params.sessionKey && params.sessionKey !== params.admission.sessionKey) {
      throw new Error(
        "openclaw-universal-capture commit sessionKey does not match the admitted turn",
      )
    }
    if (params.sessionId !== params.admission.sessionId) {
      throw new Error(
        "openclaw-universal-capture commit sessionId does not match the admitted turn",
      )
    }
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

    const result = await commitCaptureTurn({
      advancementKey: params.advancementKey,
      payload: {
        schemaVersion: 1,
        boundary: {
          admissionEntryId: params.admission.entryId,
          terminalEntryId: params.terminal.entryId,
        },
        sessionId: params.sessionId,
        sessionKey,
        workspaceDir,
        commitDate: resolveTurnCaptureDate({
          messages: params.messages,
          timezone: this.params.config.timezone,
          rolloverTime: this.params.config.rolloverTime,
        }),
        entries,
        projection: {
          folder: this.params.config.folder,
          recallFolder: this.params.config.recallFolder,
          recallTurns: this.params.config.recallTurns,
          recallMaxBytes: this.params.config.recallMaxBytes,
        },
      },
    })
    if (result.malformedRecallLines > 0) {
      this.params.logger?.warn(
        `openclaw-universal-capture ignored ${result.malformedRecallLines} malformed recall line${result.malformedRecallLines === 1 ? "" : "s"}`,
      )
    }
    this.params.logger?.debug?.(
      `openclaw-universal-capture ${result.status} turn ${params.advancementKey}; appended ${result.captureWritten} conversation entr${result.captureWritten === 1 ? "y" : "ies"} and ${result.recallWritten} recall entr${result.recallWritten === 1 ? "y" : "ies"}`,
    )
    return { status: result.status }
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
