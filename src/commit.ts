import { appendCaptureEntries } from "./capture.js"
import {
  type CaptureCommitJournal,
  type CaptureTurnCommitPayload,
} from "./commit-journal.js"
import { writeRecallEntries } from "./recall.js"

type ProjectionOperations = {
  appendCaptureEntries: typeof appendCaptureEntries
  writeRecallEntries: typeof writeRecallEntries
}

export async function commitCaptureTurn(params: {
  advancementKey: string
  journal: CaptureCommitJournal
  payload: CaptureTurnCommitPayload
  operations?: ProjectionOperations
}): Promise<{
  status: "committed" | "duplicate"
  captureWritten: number
  recallWritten: number
  malformedRecallLines: number
}> {
  const begun = params.journal.begin(params.advancementKey, params.payload)
  if (begun.projected) {
    return {
      status: "duplicate",
      captureWritten: 0,
      recallWritten: 0,
      malformedRecallLines: 0,
    }
  }

  const operations = params.operations ?? {
    appendCaptureEntries,
    writeRecallEntries,
  }
  const payload = begun.payload
  const captureWritten = await operations.appendCaptureEntries({
    workspaceDir: payload.workspaceDir,
    config: { folder: payload.projection.folder },
    entries: payload.entries,
    advancementKey: params.advancementKey,
  })
  let recallWritten = 0
  let malformedRecallLines = 0
  if (payload.projection.recallTurns > 0 && payload.entries.length > 0) {
    const recall = await operations.writeRecallEntries({
      workspaceDir: payload.workspaceDir,
      config: {
        recallFolder: payload.projection.recallFolder,
        recallTurns: payload.projection.recallTurns,
        recallMaxBytes: payload.projection.recallMaxBytes,
      },
      sessionId: payload.sessionId,
      sessionKey: payload.sessionKey,
      entries: payload.entries,
      advancementKey: params.advancementKey,
    })
    recallWritten = recall.written
    malformedRecallLines = recall.malformedLines
  }

  params.journal.complete(params.advancementKey)
  return {
    status: begun.duplicate ? "duplicate" : "committed",
    captureWritten,
    recallWritten,
    malformedRecallLines,
  }
}
