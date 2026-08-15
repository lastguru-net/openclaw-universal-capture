import assert from "node:assert/strict"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import {
  commitCaptureEntries,
  type ConversationCaptureEntry,
} from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import { UniversalCaptureContextEngine } from "../src/context-engine.js"
import { parseRecallLines, resolveRecallFilePath } from "../src/recall.js"

const sessionKey = "agent:home:discord:channel:123"

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

function acceptedTurn(
  root: string,
  advancementKey: string,
  userText = "question",
  assistantText = "answer",
): Parameters<UniversalCaptureContextEngine["commitTurn"]>[0] {
  const sessionId = "session-1"
  return {
    advancementKey,
    sessionId,
    sessionKey,
    messages: [
      {
        role: "user",
        content: userText,
        timestamp: Date.UTC(2026, 5, 1, 10, 0),
      },
      {
        role: "assistant",
        content: assistantText,
        timestamp: Date.UTC(2026, 5, 1, 10, 5),
      },
    ] as unknown as AgentMessage[],
    admission: {
      agentId: "home",
      sessionId,
      sessionKey,
      storePath: join(root, "store.sqlite"),
      generation: "generation-1",
      entryId: `user-${advancementKey}`,
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 0,
      logicalTurnId: advancementKey,
      role: "user",
    },
    terminal: {
      agentId: "home",
      sessionId,
      sessionKey,
      storePath: join(root, "store.sqlite"),
      generation: "generation-1",
      entryId: `assistant-${advancementKey}`,
      rawSeq: 2,
      effectiveParentId: `user-${advancementKey}`,
      activeMessagePosition: 1,
    },
  }
}

function engine(
  workspaceDir: string,
  config: Record<string, unknown> = {},
): UniversalCaptureContextEngine {
  return new UniversalCaptureContextEngine({
    workspaceDir,
    config: parseConfig({ timezone: "UTC", recallTurns: 10, ...config }),
  })
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

async function readRecall(workspaceDir: string) {
  return parseRecallLines(
    await readFile(
      resolveRecallFilePath({
        workspaceDir,
        recallFolder: "recall",
        sessionKey,
      }),
      "utf8",
    ),
  )
}

test("Markdown appends entries before the idempotency marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-markdown-commit-"))
  try {
    await assert.rejects(
      commitCaptureEntries({
        workspaceDir: root,
        config: { folder: "conversations" },
        date: "2026-06-01",
        entries: [entry()],
        advancementKey: "",
      }),
      /advancement key is empty/,
    )

    const params = {
      workspaceDir: root,
      config: { folder: "conversations" },
      date: "2026-06-01",
      entries: [entry()],
      advancementKey: "turn-1",
    }
    assert.deepEqual(await commitCaptureEntries(params), {
      status: "committed",
      written: 1,
    })
    assert.deepEqual(await commitCaptureEntries(params), {
      status: "duplicate",
      written: 0,
    })

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "openclaw-universal-capture:turn:"), 1)
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 1)
    assert.ok(
      markdown.lastIndexOf("**Assistant:**") <
        markdown.lastIndexOf("openclaw-universal-capture:turn:"),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("context engine serializes concurrent retries and writes once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-engine-commit-"))
  const contextEngine = engine(root)
  const turn = acceptedTurn(root, "turn-1")
  try {
    assert.deepEqual(await Promise.all([
      contextEngine.commitTurn(turn),
      contextEngine.commitTurn(turn),
    ]), [
      { status: "committed" },
      { status: "duplicate" },
    ])
    assert.deepEqual(await contextEngine.commitTurn(turn), { status: "duplicate" })

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 1)
    const recall = await readRecall(root)
    assert.equal(recall.entries.length, 1)
    assert.equal(recall.entries[0]?.advancementKey, "turn-1")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("retry appends a complete turn after a markerless partial tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-partial-append-"))
  const filePath = join(
    root,
    "conversations",
    "conversations-2026-06-01.md",
  )
  try {
    await commitCaptureEntries({
      workspaceDir: root,
      config: { folder: "conversations" },
      date: "2026-06-01",
      entries: [entry("first question", "first answer")],
      advancementKey: "turn-1",
    })
    await appendFile(filePath, "### 10:06\n\n**User:**\npartial", "utf8")

    assert.deepEqual(
      await commitCaptureEntries({
        workspaceDir: root,
        config: { folder: "conversations" },
        date: "2026-06-01",
        entries: [entry("second question", "second answer")],
        advancementKey: "turn-2",
      }),
      { status: "committed", written: 1 },
    )

    const markdown = await readFile(filePath, "utf8")
    assert.match(markdown, /\*\*User:\*\*\npartial### 10:05/)
    assert.equal(countOccurrences(markdown, "second question"), 1)
    assert.equal(countOccurrences(markdown, "second answer"), 1)
    assert.equal(countOccurrences(markdown, "openclaw-universal-capture:turn:"), 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("filtered turns use marker-only Markdown commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-empty-commit-"))
  const contextEngine = engine(root, { skipNoReply: true, recallTurns: 0 })
  const turn = acceptedTurn(root, "turn-1", "question", "NO_REPLY")
  try {
    assert.deepEqual(await contextEngine.commitTurn(turn), { status: "committed" })
    assert.deepEqual(await contextEngine.commitTurn(turn), { status: "duplicate" })

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

test("retry repairs recall after Markdown committed first", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-repair-"))
  const contextEngine = engine(root)
  try {
    await commitCaptureEntries({
      workspaceDir: root,
      config: { folder: "conversations" },
      date: "2026-06-01",
      entries: [entry()],
      advancementKey: "turn-1",
    })

    assert.deepEqual(
      await contextEngine.commitTurn(acceptedTurn(root, "turn-1")),
      { status: "duplicate" },
    )
    const recall = await readRecall(root)
    assert.equal(recall.entries.length, 1)
    assert.equal(recall.entries[0]?.advancementKey, "turn-1")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("one accepted turn crossing rollover stays in one Markdown file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-cross-rollover-"))
  try {
    await commitCaptureEntries({
      workspaceDir: root,
      config: { folder: "conversations" },
      date: "2026-06-02",
      entries: [
        entry("before", "first", "2026-06-01"),
        entry("after", "second", "2026-06-02"),
      ],
      advancementKey: "turn-1",
    })

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
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("concurrent accepted turns do not lose either projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-concurrent-"))
  const contextEngine = engine(root)
  try {
    await Promise.all([
      contextEngine.commitTurn(acceptedTurn(root, "turn-1")),
      contextEngine.commitTurn(
        acceptedTurn(root, "turn-2", "question 2", "answer 2"),
      ),
    ])

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 2)
    assert.match(markdown, /question 2\n/)
    assert.match(markdown, /answer 2\n/)
    assert.deepEqual(
      new Set((await readRecall(root)).entries.map((item) => item.advancementKey)),
      new Set(["turn-1", "turn-2"]),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("context engine declares the durable OpenClaw turn contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-engine-"))
  const contextEngine = engine(root)
  try {
    assert.deepEqual(contextEngine.info.acceptedHostParams, ["sessionKey"])
    assert.deepEqual(contextEngine.info.transcriptSemantics, {
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    })
    assert.equal(typeof contextEngine.commitTurn, "function")
    assert.equal("afterTurn" in contextEngine, false)
    assert.deepEqual(await contextEngine.bootstrap(), { bootstrapped: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
