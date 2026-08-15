import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import {
  appendCaptureEntries,
  type ConversationCaptureEntry,
} from "../src/capture.js"
import {
  CaptureCommitJournal,
  type CaptureTurnCommitPayload,
} from "../src/commit-journal.js"
import { commitCaptureTurn } from "../src/commit.js"
import { UniversalCaptureContextEngine } from "../src/context-engine.js"
import { parseConfig } from "../src/config.js"
import {
  parseRecallLines,
  resolveRecallFilePath,
  writeRecallEntries,
} from "../src/recall.js"

function entry(userText = "question", assistantText = "answer"): ConversationCaptureEntry {
  return {
    date: "2026-06-01",
    time: "10:05",
    timestamp: "2026-06-01T10:05:00.000Z",
    userText,
    assistantText,
  }
}

function payload(
  workspaceDir: string,
  overrides: Partial<CaptureTurnCommitPayload> = {},
): CaptureTurnCommitPayload {
  return {
    schemaVersion: 1,
    boundary: {
      admissionEntryId: "entry-user",
      terminalEntryId: "entry-assistant",
    },
    sessionId: "session-1",
    sessionKey: "agent:home:discord:channel:123",
    workspaceDir,
    entries: [entry()],
    projection: {
      folder: "conversations",
      recallFolder: "recall",
      recallTurns: 10,
      recallMaxBytes: 0,
    },
    ...overrides,
  }
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

test("CaptureCommitJournal atomically deduplicates keys and rejects collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-journal-"))
  const journal = new CaptureCommitJournal(join(root, "state"))
  try {
    assert.throws(() => journal.begin("", payload(root)), /advancement key is empty/)

    const first = journal.begin("turn-1", payload(root))
    assert.equal(first.duplicate, false)
    assert.equal(first.projected, false)

    const pendingRetry = journal.begin("turn-1", payload(root))
    assert.equal(pendingRetry.duplicate, true)
    assert.equal(pendingRetry.projected, false)

    assert.throws(
      () =>
        journal.begin(
          "turn-1",
          payload(root, {
            entries: [entry("different question", "different answer")],
          }),
        ),
      /advancement key collision/,
    )

    journal.complete("turn-1")
    const completedRetry = journal.begin("turn-1", payload(root))
    assert.equal(completedRetry.duplicate, true)
    assert.equal(completedRetry.projected, true)
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("commitCaptureTurn writes each accepted turn exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-commit-"))
  const journal = new CaptureCommitJournal(join(root, "state"))
  const turn = payload(root)
  try {
    const first = await commitCaptureTurn({
      advancementKey: "turn-1",
      journal,
      payload: turn,
    })
    const duplicate = await commitCaptureTurn({
      advancementKey: "turn-1",
      journal,
      payload: turn,
    })

    assert.deepEqual(first, {
      status: "committed",
      captureWritten: 1,
      recallWritten: 1,
      malformedRecallLines: 0,
    })
    assert.deepEqual(duplicate, {
      status: "duplicate",
      captureWritten: 0,
      recallWritten: 0,
      malformedRecallLines: 0,
    })

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 1)

    const recall = parseRecallLines(
      await readFile(
        resolveRecallFilePath({
          workspaceDir: root,
          recallFolder: "recall",
          sessionKey: turn.sessionKey,
        }),
        "utf8",
      ),
    )
    assert.equal(recall.entries.length, 1)
    assert.equal(recall.entries[0]?.advancementKey, "turn-1")
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("retry repairs a crash between Markdown and recall projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-repair-"))
  const journal = new CaptureCommitJournal(join(root, "state"))
  const original = payload(root)
  try {
    await assert.rejects(
      commitCaptureTurn({
        advancementKey: "turn-1",
        journal,
        payload: original,
        operations: {
          appendCaptureEntries,
          writeRecallEntries: async () => {
            throw new Error("simulated recall failure")
          },
        },
      }),
      /simulated recall failure/,
    )

    const changedConfigRetry = payload(root, {
      projection: {
        ...original.projection,
        folder: "wrong-new-folder",
        recallFolder: "wrong-new-recall",
      },
    })
    const repaired = await commitCaptureTurn({
      advancementKey: "turn-1",
      journal,
      payload: changedConfigRetry,
    })
    assert.equal(repaired.status, "duplicate")
    assert.equal(repaired.captureWritten, 0)
    assert.equal(repaired.recallWritten, 1)

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 1)
    await assert.rejects(
      readFile(
        join(root, "wrong-new-folder", "conversations-2026-06-01.md"),
        "utf8",
      ),
      /ENOENT/,
    )
    const recall = parseRecallLines(
      await readFile(
        resolveRecallFilePath({
          workspaceDir: root,
          recallFolder: "recall",
          sessionKey: original.sessionKey,
        }),
        "utf8",
      ),
    )
    assert.equal(recall.entries.length, 1)
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("retry recognizes projections completed before the journal completion flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-reconcile-"))
  const journal = new CaptureCommitJournal(join(root, "state"))
  const turn = payload(root)
  try {
    journal.begin("turn-1", turn)
    await appendCaptureEntries({
      workspaceDir: root,
      config: { folder: turn.projection.folder },
      entries: turn.entries,
      advancementKey: "turn-1",
    })
    await writeRecallEntries({
      workspaceDir: root,
      config: turn.projection,
      sessionId: turn.sessionId,
      sessionKey: turn.sessionKey,
      entries: turn.entries,
      advancementKey: "turn-1",
    })

    const repaired = await commitCaptureTurn({
      advancementKey: "turn-1",
      journal,
      payload: turn,
    })
    assert.deepEqual(repaired, {
      status: "duplicate",
      captureWritten: 0,
      recallWritten: 0,
      malformedRecallLines: 0,
    })
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("concurrent accepted turns do not lose either file projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-concurrent-"))
  const journal = new CaptureCommitJournal(join(root, "state"))
  const first = payload(root)
  const second = payload(root, {
    boundary: {
      admissionEntryId: "entry-user-2",
      terminalEntryId: "entry-assistant-2",
    },
    entries: [entry("question 2", "answer 2")],
  })
  try {
    await Promise.all([
      commitCaptureTurn({
        advancementKey: "turn-1",
        journal,
        payload: first,
      }),
      commitCaptureTurn({
        advancementKey: "turn-2",
        journal,
        payload: second,
      }),
    ])

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 2)
    assert.ok(markdown.includes("question\n"))
    assert.ok(markdown.includes("answer\n"))
    assert.ok(markdown.includes("question 2\n"))
    assert.ok(markdown.includes("answer 2\n"))

    const recall = parseRecallLines(
      await readFile(
        resolveRecallFilePath({
          workspaceDir: root,
          recallFolder: "recall",
          sessionKey: first.sessionKey,
        }),
        "utf8",
      ),
    )
    assert.equal(recall.entries.length, 2)
    assert.deepEqual(
      new Set(recall.entries.map((item) => item.advancementKey)),
      new Set(["turn-1", "turn-2"]),
    )
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("context engine declares the full durable OpenClaw turn contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-engine-"))
  const engine = new UniversalCaptureContextEngine({
    config: parseConfig({}),
    agentDir: join(root, "agent"),
    workspaceDir: join(root, "workspace"),
  })
  try {
    assert.deepEqual(engine.info.acceptedHostParams, [
      "sessionKey",
      "sessionTarget",
      "runtimeSettings",
      "runtimeContext",
    ])
    assert.deepEqual(engine.info.transcriptSemantics, {
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    })
    assert.equal(typeof engine.commitTurn, "function")
    assert.equal("afterTurn" in engine, false)
    assert.deepEqual(await engine.bootstrap(), { bootstrapped: true })
  } finally {
    await engine.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("context engine commits the admitted message range through the durable pipeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-engine-commit-"))
  const workspaceDir = join(root, "workspace")
  const sessionKey = "agent:home:discord:channel:123"
  const engine = new UniversalCaptureContextEngine({
    config: parseConfig({
      recallTurns: 3,
      timezone: "UTC",
    }),
    agentDir: join(root, "agent"),
    workspaceDir,
  })
  const messages = [
    {
      role: "user",
      content: "engine question",
      timestamp: Date.UTC(2026, 5, 1, 10, 0),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "engine answer" }],
      timestamp: Date.UTC(2026, 5, 1, 10, 5),
      api: "openai",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
    },
  ] as unknown as AgentMessage[]
  const admission = {
    agentId: "home",
    sessionId: "session-1",
    sessionKey,
    storePath: join(root, "store.sqlite"),
    generation: "generation-1",
    entryId: "entry-user",
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: "turn-engine",
    role: "user" as const,
  }
  const terminal = {
    agentId: "home",
    sessionId: "session-1",
    sessionKey,
    storePath: join(root, "store.sqlite"),
    generation: "generation-1",
    entryId: "entry-assistant",
    rawSeq: 2,
    effectiveParentId: "entry-user",
    activeMessagePosition: 1,
  }
  try {
    const first = await engine.commitTurn({
      advancementKey: "turn-engine",
      admission,
      terminal,
      messages,
      sessionId: "session-1",
      sessionKey,
    })
    const duplicate = await engine.commitTurn({
      advancementKey: "turn-engine",
      admission,
      terminal,
      messages,
      sessionId: "session-1",
      sessionKey,
    })
    assert.deepEqual(first, { status: "committed" })
    assert.deepEqual(duplicate, { status: "duplicate" })

    const markdown = await readFile(
      join(workspaceDir, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "engine answer"), 1)
    const recall = parseRecallLines(
      await readFile(
        resolveRecallFilePath({
          workspaceDir,
          recallFolder: "recall",
          sessionKey,
        }),
        "utf8",
      ),
    )
    assert.equal(recall.entries.length, 1)
    assert.equal(recall.entries[0]?.advancementKey, "turn-engine")
  } finally {
    await engine.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
