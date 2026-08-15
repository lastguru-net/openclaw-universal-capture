import { createHash } from "node:crypto"

import {
  commitCaptureEntries,
  type ConversationCaptureEntry,
} from "./capture.js"
import { writeRecallEntries } from "./recall.js"

export type CaptureTurnCommitPayload = {
  schemaVersion: 1
  boundary: {
    admissionEntryId: string
    terminalEntryId: string
  }
  sessionId: string
  sessionKey: string
  workspaceDir: string
  commitDate: string
  entries: ConversationCaptureEntry[]
  projection: {
    folder: string
    recallFolder: string
    recallTurns: number
    recallMaxBytes: number
  }
}

type ProjectionOperations = {
  commitCaptureEntries: typeof commitCaptureEntries
  writeRecallEntries: typeof writeRecallEntries
}

export function hashCommitIdentity(payload: CaptureTurnCommitPayload): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: payload.schemaVersion,
        boundary: payload.boundary,
        sessionId: payload.sessionId,
        sessionKey: payload.sessionKey,
        entries: payload.entries,
      }),
    )
    .digest("hex")
}

export async function commitCaptureTurn(params: {
  advancementKey: string
  payload: CaptureTurnCommitPayload
  operations?: ProjectionOperations
}): Promise<{
  status: "committed" | "duplicate"
  captureWritten: number
  recallWritten: number
  malformedRecallLines: number
}> {
  const operations = params.operations ?? {
    commitCaptureEntries,
    writeRecallEntries,
  }
  const capture = await operations.commitCaptureEntries({
    workspaceDir: params.payload.workspaceDir,
    config: { folder: params.payload.projection.folder },
    date: params.payload.commitDate,
    entries: params.payload.entries,
    advancementKey: params.advancementKey,
    payloadHash: hashCommitIdentity(params.payload),
  })

  let recallWritten = 0
  let malformedRecallLines = 0
  if (
    params.payload.projection.recallTurns > 0 &&
    params.payload.entries.length > 0
  ) {
    const recall = await operations.writeRecallEntries({
      workspaceDir: params.payload.workspaceDir,
      config: {
        recallFolder: params.payload.projection.recallFolder,
        recallTurns: params.payload.projection.recallTurns,
        recallMaxBytes: params.payload.projection.recallMaxBytes,
      },
      sessionId: params.payload.sessionId,
      sessionKey: params.payload.sessionKey,
      entries: params.payload.entries,
      advancementKey: params.advancementKey,
    })
    recallWritten = recall.written
    malformedRecallLines = recall.malformedLines
  }

  return {
    status: capture.status,
    captureWritten: capture.written,
    recallWritten,
    malformedRecallLines,
  }
}
