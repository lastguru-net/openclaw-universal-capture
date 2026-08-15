import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import {
  commitCaptureEntries,
  type ConversationCaptureEntry,
} from "../src/capture.js"
import {
  commitCaptureTurn,
  hashCommitIdentity,
  type CaptureTurnCommitPayload,
} from "../src/commit.js"
import { UniversalCaptureContextEngine } from "../src/context-engine.js"
import { parseConfig } from "../src/config.js"
import {
  parseRecallLines,
  resolveRecallFilePath,
  writeRecallEntries,
} from "../src/recall.js"

function entry(
  userText = "question",
  assistantText = "answer",
  date = "2026-06-01",
): ConversationCaptureEntry {
  return {
    date,
    time: "10:05",
    timestamp: `${date}T10:05:00.000Z`,
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
    commitDate: "2026-06-01",
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

test("Markdown is the atomic idempotency record and rejects key collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-markdown-commit-"))
  const first = payload(root)
  try {
    await assert.rejects(
      commitCaptureEntries({
        workspaceDir: root,
        config: first.projection,
        date: first.commitDate,
        entries: first.entries,
        advancementKey: "",
        payloadHash: hashCommitIdentity(first),
      }),
      /advancement key is empty/,
    )

    const committed = await commitCaptureEntries({
      workspaceDir: root,
      config: first.projection,
      date: first.commitDate,
      entries: first.entries,
      advancementKey: "turn-1",
      payloadHash: hashCommitIdentity(first),
    })
    const duplicate = await commitCaptureEntries({
      workspaceDir: root,
      config: first.projection,
      date: first.commitDate,
      entries: first.entries,
      advancementKey: "turn-1",
      payloadHash: hashCommitIdentity(first),
    })

    assert.deepEqual(committed, { status: "committed", written: 1 })
    assert.deepEqual(duplicate, { status: "duplicate", written: 0 })

    const collision = payload(root, {
      entries: [entry("different question", "different answer")],
    })
    await assert.rejects(
      commitCaptureEntries({
        workspaceDir: root,
        config: collision.projection,
        date: collision.commitDate,
        entries: collision.entries,
        advancementKey: "turn-1",
        payloadHash: hashCommitIdentity(collision),
      }),
      /advancement key collision/,
    )

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "openclaw-universal-capture:turn:"), 1)
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("commitCaptureTurn writes each accepted turn exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-commit-"))
  const turn = payload(root)
  try {
    const first = await commitCaptureTurn({
      advancementKey: "turn-1",
      payload: turn,
    })
    const duplicate = await commitCaptureTurn({
      advancementKey: "turn-1",
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
    await rm(root, { recursive: true, force: true })
  }
})

test("filtered turns use marker-only Markdown commits for durable retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-empty-commit-"))
  const turn = payload(root, { entries: [] })
  try {
    const first = await commitCaptureTurn({
      advancementKey: "turn-1",
      payload: turn,
    })
    const duplicate = await commitCaptureTurn({
      advancementKey: "turn-1",
      payload: turn,
    })
    assert.equal(first.status, "committed")
    assert.equal(duplicate.status, "duplicate")
    assert.equal(first.captureWritten, 0)
    assert.equal(duplicate.captureWritten, 0)

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "openclaw-universal-capture:turn:"), 1)
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("retry repairs recall after Markdown was committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-repair-"))
  const turn = payload(root)
  try {
    await assert.rejects(
      commitCaptureTurn({
        advancementKey: "turn-1",
        payload: turn,
        operations: {
          commitCaptureEntries,
          writeRecallEntries: async () => {
            throw new Error("simulated recall failure")
          },
        },
      }),
      /simulated recall failure/,
    )

    const repaired = await commitCaptureTurn({
      advancementKey: "turn-1",
      payload: turn,
    })
    assert.deepEqual(repaired, {
      status: "duplicate",
      captureWritten: 0,
      recallWritten: 1,
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("retry recognizes both files written before acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-reconcile-"))
  const turn = payload(root)
  try {
    await assert.rejects(
      commitCaptureTurn({
        advancementKey: "turn-1",
        payload: turn,
        operations: {
          commitCaptureEntries,
          writeRecallEntries: async (params) => {
            await writeRecallEntries(params)
            throw new Error("simulated acknowledgement failure")
          },
        },
      }),
      /simulated acknowledgement failure/,
    )

    const repaired = await commitCaptureTurn({
      advancementKey: "turn-1",
      payload: turn,
    })
    assert.deepEqual(repaired, {
      status: "duplicate",
      captureWritten: 0,
      recallWritten: 0,
      malformedRecallLines: 0,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("one logical turn crossing rollover is committed to one Markdown file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-cross-rollover-"))
  const turn = payload(root, {
    commitDate: "2026-06-02",
    entries: [
      entry("before", "first", "2026-06-01"),
      entry("after", "second", "2026-06-02"),
    ],
  })
  try {
    const result = await commitCaptureTurn({
      advancementKey: "turn-1",
      payload: turn,
    })
    assert.equal(result.status, "committed")

    await assert.rejects(
      readFile(
        join(root, "conversations", "conversations-2026-06-01.md"),
        "utf8",
      ),
      /ENOENT/,
    )
    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-02.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "openclaw-universal-capture:turn:"), 1)
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("concurrent accepted turns do not lose either file projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-concurrent-"))
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
      commitCaptureTurn({ advancementKey: "turn-1", payload: first }),
      commitCaptureTurn({ advancementKey: "turn-2", payload: second }),
    ])

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 2)
    assert.match(markdown, /question\n/)
    assert.match(markdown, /answer\n/)
    assert.match(markdown, /question 2\n/)
    assert.match(markdown, /answer 2\n/)

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
    await rm(root, { recursive: true, force: true })
  }
})

test("context engine declares the full durable OpenClaw turn contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-engine-"))
  const engine = new UniversalCaptureContextEngine({
    config: parseConfig({}),
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
    await rm(root, { recursive: true, force: true })
  }
})
