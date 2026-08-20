import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import {
  appendCaptureEntries,
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

function acceptedTurnWithProgress(
  root: string,
  advancementKey: string,
): Parameters<UniversalCaptureContextEngine["commitTurn"]>[0] {
  const turn = acceptedTurn(root, advancementKey)
  turn.messages = [
    turn.messages[0]!,
    {
      role: "assistant",
      content: "commentary",
      timestamp: Date.UTC(2026, 5, 1, 10, 1),
    },
    {
      role: "assistant",
      content: "Codex plan: pending",
      timestamp: Date.UTC(2026, 5, 1, 10, 2),
    },
    turn.messages[1]!,
  ] as AgentMessage[]
  turn.terminal = {
    ...turn.terminal,
    rawSeq: 4,
    activeMessagePosition: 3,
  }
  return turn
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

test("Markdown uses exclusive header creation and direct append", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-markdown-append-"))
  try {
    await Promise.all([
      appendCaptureEntries({
        workspaceDir: root,
        config: { folder: "conversations" },
        entries: [entry("first question", "first answer")],
      }),
      appendCaptureEntries({
        workspaceDir: root,
        config: { folder: "conversations" },
        entries: [entry("second question", "second answer")],
      }),
    ])

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "type: Conversation"), 1)
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 2)
    assert.match(markdown, /first answer/)
    assert.match(markdown, /second answer/)
    assert.doesNotMatch(markdown, /openclaw-universal-capture:turn:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("context engine writes recall before appending Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-engine-commit-"))
  const contextEngine = engine(root)
  try {
    assert.deepEqual(
      await contextEngine.commitTurn(acceptedTurn(root, "turn-1")),
      { status: "committed" },
    )

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

test("context engine captures only the terminal response by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-engine-final-only-"))
  const contextEngine = engine(root)
  try {
    await contextEngine.commitTurn(acceptedTurnWithProgress(root, "turn-1"))

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 1)
    assert.doesNotMatch(markdown, /commentary/)
    assert.doesNotMatch(markdown, /Codex plan/)
    assert.match(markdown, /answer/)
    assert.deepEqual(
      (await readRecall(root)).entries.map((item) => item.assistantText),
      ["answer"],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("context engine preserves 0.7.0 all-text capture when commentary is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-engine-commentary-"))
  const contextEngine = engine(root, { commentary: true })
  try {
    await contextEngine.commitTurn(acceptedTurnWithProgress(root, "turn-1"))

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 3)
    assert.match(markdown, /commentary/)
    assert.match(markdown, /Codex plan/)
    assert.deepEqual(
      (await readRecall(root)).entries.map((item) => item.assistantText),
      ["commentary", "Codex plan: pending", "answer"],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recall failure happens before Markdown is appended", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-recall-failure-"))
  const contextEngine = engine(root)
  try {
    await writeFile(join(root, "recall"), "not a directory", "utf8")
    await assert.rejects(
      contextEngine.commitTurn(acceptedTurn(root, "turn-1")),
    )
    await assert.rejects(
      readFile(
        join(root, "conversations", "conversations-2026-06-01.md"),
        "utf8",
      ),
      /ENOENT/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("retry after Markdown failure reuses deduplicated recall", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-markdown-failure-"))
  const contextEngine = engine(root)
  const conversationsPath = join(root, "conversations")
  const turn = acceptedTurn(root, "turn-1")
  try {
    await writeFile(conversationsPath, "not a directory", "utf8")
    await assert.rejects(contextEngine.commitTurn(turn))
    assert.equal((await readRecall(root)).entries.length, 1)

    await rm(conversationsPath, { force: true })
    assert.deepEqual(await contextEngine.commitTurn(turn), { status: "committed" })
    assert.equal((await readRecall(root)).entries.length, 1)
    const markdown = await readFile(
      join(conversationsPath, "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a replay after completed append can duplicate Markdown only", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-replay-"))
  const contextEngine = engine(root)
  const turn = acceptedTurn(root, "turn-1")
  try {
    assert.deepEqual(await contextEngine.commitTurn(turn), { status: "committed" })
    assert.deepEqual(await contextEngine.commitTurn(turn), { status: "committed" })

    const markdown = await readFile(
      join(root, "conversations", "conversations-2026-06-01.md"),
      "utf8",
    )
    assert.equal(countOccurrences(markdown, "**Assistant:**"), 2)
    assert.equal((await readRecall(root)).entries.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("filtered turns write nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-filtered-"))
  const contextEngine = engine(root, { skipNoReply: true, recallTurns: 0 })
  const turn = acceptedTurn(root, "turn-1", "question", "NO_REPLY")
  try {
    assert.deepEqual(await contextEngine.commitTurn(turn), { status: "committed" })
    await assert.rejects(readFile(join(root, "conversations"), "utf8"), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("entries crossing rollover are appended to their daily files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-cross-rollover-"))
  try {
    assert.equal(
      await appendCaptureEntries({
        workspaceDir: root,
        config: { folder: "conversations" },
        entries: [
          entry("before", "first", "2026-06-01"),
          entry("after", "second", "2026-06-02"),
        ],
      }),
      2,
    )
    assert.match(
      await readFile(
        join(root, "conversations", "conversations-2026-06-01.md"),
        "utf8",
      ),
      /first/,
    )
    assert.match(
      await readFile(
        join(root, "conversations", "conversations-2026-06-02.md"),
        "utf8",
      ),
      /second/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("concurrent accepted turns preserve both projections", async () => {
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
    assert.deepEqual(
      new Set((await readRecall(root)).entries.map((item) => item.advancementKey)),
      new Set(["turn-1", "turn-2"]),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("context engine declares the OpenClaw turn contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-engine-"))
  const contextEngine = engine(root)
  try {
    assert.deepEqual(contextEngine.info.acceptedHostParams, ["sessionKey"])
    assert.deepEqual(contextEngine.info.transcriptSemantics, {
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    })
    assert.equal(contextEngine.info.version, "0.7.1")
    assert.equal(typeof contextEngine.commitTurn, "function")
    assert.equal("afterTurn" in contextEngine, false)
    assert.deepEqual(await contextEngine.bootstrap(), { bootstrapped: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
