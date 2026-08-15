import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { ConversationCaptureEntry } from "./capture.js"

export type CaptureTurnCommitPayload = {
  schemaVersion: 1
  boundary: {
    admissionEntryId: string
    terminalEntryId: string
  }
  sessionId: string
  sessionKey: string
  workspaceDir: string
  entries: ConversationCaptureEntry[]
  projection: {
    folder: string
    recallFolder: string
    recallTurns: number
    recallMaxBytes: number
  }
}

type JournalRow = {
  payload_hash: string
  payload_json: string | null
  projected: number
}

export type BeginCommitResult = {
  duplicate: boolean
  projected: boolean
  payload: CaptureTurnCommitPayload
}

function hashCommitIdentity(payload: CaptureTurnCommitPayload): string {
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

export class CaptureCommitJournal {
  readonly filePath: string
  private readonly database: DatabaseSync

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true })
    this.filePath = resolve(stateDir, "openclaw-universal-capture.sqlite")
    this.database = new DatabaseSync(this.filePath)
    this.database.exec("PRAGMA busy_timeout = 5000")
    this.database.exec("PRAGMA journal_mode = WAL")
    this.database.exec("PRAGMA synchronous = FULL")
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS committed_turns (
        advancement_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        payload_json TEXT,
        projected INTEGER NOT NULL DEFAULT 0 CHECK (projected IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        projected_at TEXT
      )
    `)
  }

  begin(
    advancementKey: string,
    payload: CaptureTurnCommitPayload,
  ): BeginCommitResult {
    if (!advancementKey) {
      throw new Error("openclaw-universal-capture advancement key is empty")
    }
    const payloadHash = hashCommitIdentity(payload)
    const payloadJson = JSON.stringify(payload)
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const existing = this.database
        .prepare(
          "SELECT payload_hash, payload_json, projected FROM committed_turns WHERE advancement_key = ?",
        )
        .get(advancementKey) as JournalRow | undefined

      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw new Error(
            `openclaw-universal-capture advancement key collision: ${advancementKey}`,
          )
        }
        if (existing.projected === 1) {
          this.database.exec("COMMIT")
          return { duplicate: true, projected: true, payload }
        }
        if (!existing.payload_json) {
          throw new Error(
            `openclaw-universal-capture pending commit has no payload: ${advancementKey}`,
          )
        }
        const storedPayload = JSON.parse(existing.payload_json) as CaptureTurnCommitPayload
        this.database.exec("COMMIT")
        return {
          duplicate: true,
          projected: false,
          payload: storedPayload,
        }
      }

      this.database
        .prepare(
          "INSERT INTO committed_turns (advancement_key, payload_hash, payload_json) VALUES (?, ?, ?)",
        )
        .run(advancementKey, payloadHash, payloadJson)
      this.database.exec("COMMIT")
      return { duplicate: false, projected: false, payload }
    } catch (error) {
      try {
        this.database.exec("ROLLBACK")
      } catch {
        // Preserve the original transaction error.
      }
      throw error
    }
  }

  complete(advancementKey: string): void {
    const result = this.database
      .prepare(
        `UPDATE committed_turns
         SET projected = 1, payload_json = NULL, projected_at = CURRENT_TIMESTAMP
         WHERE advancement_key = ?`,
      )
      .run(advancementKey)
    if (Number(result.changes) !== 1) {
      throw new Error(
        `openclaw-universal-capture cannot complete unknown advancement key: ${advancementKey}`,
      )
    }
  }

  close(): void {
    this.database.close()
  }
}
