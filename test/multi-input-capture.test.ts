import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import { renderCaptureEntry, selectCaptureEntries } from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import { UniversalCaptureContextEngine } from "../src/context-engine.js"
import { createUniversalRecallTool, parseRecallLines, resolveRecallFilePath } from "../src/recall.js"

const sessionKey = "agent:test:discord:channel:123"
const timestamp = Date.UTC(2026, 10, 13, 12)
const user = (content: string, senderUsername?: string) => ({
  role: "user", content, timestamp,
  ...(senderUsername ? { __openclaw: { senderUsername } } : {}),
})
const assistant = (content: string) => ({ role: "assistant", content, timestamp })
const tool = { role: "toolResult", content: "tool output", timestamp }
const messages = [user("Original request", "alice"), assistant("Working"), tool,
  user("Additional request", "bob"), tool, assistant("Combined answer")]

function select(rows: unknown[], config: Record<string, unknown> = {}, start = 0) {
  return selectCaptureEntries({
    ...parseConfig({ timezone: "UTC", ...config }),
    messages: rows as AgentMessage[], prePromptMessageCount: start, sessionKey,
  })
}

test("one accepted record preserves original and steering inputs before its answer", () => {
  const entries = select(messages, { includeMessageMetadata: true })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.userText, "Original request\n\nAdditional request")
  const rendered = renderCaptureEntry(entries[0]!)
  assert.equal(rendered.split("**User:**").length - 1, 2)
  assert.equal(rendered.split("**Assistant:**").length - 1, 1)
  assert.match(rendered, /\*\*User:\*\*\nSender: alice\nOriginal request/)
  assert.match(rendered, /\*\*User:\*\*\nSender: bob\nAdditional request/)
  assert.doesNotMatch(rendered, /Working|tool output/)
})

test("bounded inputs preserve order and duplicates without old or future users", () => {
  const rows = [user("previous"), assistant("previous answer"),
    user("same"), tool, user("same"), user("third"), assistant("answer")]
  const entry = select(rows, {}, 2)[0]!
  assert.deepEqual(entry.userInputs?.map((input) => input.text), ["same", "same", "third"])
  assert.equal(entry.userText, "same\n\nsame\n\nthird")
  assert.equal(select([user("outside"), assistant("answer")], {}, 1).length, 0)
  assert.equal(select([assistant("answer"), user("future")], { commentary: true }).length, 0)
})

test("commentary entries include only inputs already present at that point", () => {
  assert.deepEqual(select(messages, { commentary: true }).map((entry) => [entry.userText, entry.assistantText]), [
    ["Original request", "Working"],
    ["Original request\n\nAdditional request", "Combined answer"],
  ])
})

test("multi-input delivery mirrors still win over receipts and silent completion", () => {
  const mirror = { ...assistant("Delivered answer"), openclawDeliveryMirror: {
    kind: "message-tool-source-reply", final: true, sourceTurnId: "turn-1",
  } }
  const entry = select([...messages.slice(0, -1), mirror, tool, assistant("NO_REPLY")], { skipNoReply: true })[0]!
  assert.equal(entry.assistantText, "Delivered answer")
  assert.equal(entry.userInputs?.length, 2)
  assert.equal(select([...messages.slice(0, -1), assistant("NO_REPLY")], { skipNoReply: true }).length, 0)
})

test("each user is normalized separately and optional sender display is respected", () => {
  const decorated = (text: string) => `Conversation info (untrusted metadata):\n\`\`\`json\n{}\n\`\`\`\n\n${text}`
  const rows = [user(decorated("first"), "alice"), user(decorated("second"), "bob"), assistant("answer")]
  const entry = select(rows)[0]!
  assert.deepEqual(entry.userInputs, [
    { text: "first", senderUsername: "alice" }, { text: "second", senderUsername: "bob" },
  ])
  assert.doesNotMatch(renderCaptureEntry(entry), /Sender:|Conversation info/)
  assert.deepEqual(select(rows, { stripUntrustedMetadata: false })[0]!.userInputs?.map((input) => input.text),
    [decorated("first"), decorated("second")])
  const withoutSession = selectCaptureEntries({
    ...parseConfig({ timezone: "UTC", includeMessageMetadata: true }),
    messages: rows as AgentMessage[], prePromptMessageCount: 0,
  })[0]!
  assert.match(renderCaptureEntry(withoutSession), /Sender: alice/)
})

test("excluded, human-addressed and textless rows are not captured as agent inputs", () => {
  const entry = select([
    user("original"), { ...user("excluded"), excludeFromContext: true },
    { ...user("for a person"), __openclaw: { humanAddressed: true } }, user(" "),
    { role: "user", content: [{ type: "image", data: "fixture" }] },
    user("steering"), assistant("answer"),
  ])[0]!
  assert.deepEqual(entry.userInputs?.map((input) => input.text), ["original", "steering"])
})

test("metadata-light accepted steering does not require matching run IDs", () => {
  const entry = select([user("original"),
    { ...user("steering"), __openclaw: { steerTargetRunId: "run-1" } }, assistant("answer"),
  ])[0]!
  assert.equal(entry.userInputs?.length, 2)
})

test("single-input shape stays compatible with top-level and canonical sender metadata", () => {
  for (const input of [user("question", "alice"), { ...user("question"), senderUsername: "alice" }]) {
    const entry = select([input, assistant("answer")], { includeMessageMetadata: true })[0]!
    assert.equal(entry.userText, "question")
    assert.equal(entry.userInputs, undefined)
    assert.equal(entry.senderUsername, "alice")
    assert.match(renderCaptureEntry(entry), /Sender: alice\n\n\*\*User:\*\*\nquestion/)
  }
})

test("recall parses legacy records and rejects malformed structured inputs", () => {
  const legacy = { timestamp: new Date(timestamp).toISOString(), sessionKey,
    userText: "old request", assistantText: "old answer" }
  assert.deepEqual(parseRecallLines(JSON.stringify(legacy)).entries, [legacy])
  for (const userInputs of [[], "not an array", [null], [{ text: 12 }]]) {
    assert.equal(parseRecallLines(JSON.stringify({ ...legacy, userInputs })).malformedLines, 1)
  }
})

test("commitTurn persists one multi-input record and recall returns both inputs once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ouc-multi-input-"))
  try {
    const config = parseConfig({ timezone: "UTC", recallTurns: 2, includeMessageMetadata: true })
    const path = resolveRecallFilePath({ workspaceDir: root, recallFolder: config.recallFolder, sessionKey })
    await mkdir(dirname(path), { recursive: true })
    const legacy = { timestamp: new Date(timestamp - 1000).toISOString(), sessionKey,
      userText: "old request", assistantText: "old answer" }
    await writeFile(path, JSON.stringify(legacy) + "\n")
    const engine = new UniversalCaptureContextEngine({ workspaceDir: root, config })
    const scope = { agentId: "test", sessionId: "session-1", sessionKey,
      storePath: join(root, "store.sqlite"), generation: "generation-1" }
    const turn = {
      advancementKey: "turn-1", sessionId: scope.sessionId, sessionKey,
      messages: messages as AgentMessage[],
      admission: { ...scope, entryId: "user-1", rawSeq: 1, effectiveParentId: null,
        activeMessagePosition: 0, logicalTurnId: "turn-1", role: "user" as const },
      terminal: { ...scope, entryId: "answer-1", rawSeq: messages.length,
        effectiveParentId: "tool-1", activeMessagePosition: messages.length - 1 },
    }
    await engine.commitTurn(turn)
    const markdown = await readFile(join(root, "conversations", "conversations-2026-11-13.md"), "utf8")
    assert.equal(markdown.split("**User:**").length - 1, 2)
    assert.equal(markdown.split("**Assistant:**").length - 1, 1)
    const recalled = parseRecallLines(await readFile(path, "utf8"))
    assert.equal(recalled.malformedLines, 0)
    assert.equal(recalled.entries.length, 2)
    assert.deepEqual(recalled.entries[0], legacy)
    assert.deepEqual(recalled.entries[1]!.userInputs, [
      { text: "Original request", senderUsername: "alice" },
      { text: "Additional request", senderUsername: "bob" },
    ])
    assert.equal(recalled.entries[1]!.senderUsername, undefined)
    const recallTool = createUniversalRecallTool({ config, context: { workspaceDir: root, sessionKey } as never })
    const output = (await recallTool.execute("read", { maxTurns: 1 })).content[0]!.text
    assert.equal(output.split("User:\n").length - 1, 2)
    assert.equal(output.split("Assistant:\n").length - 1, 1)
    assert.doesNotMatch(output, /old request/)
    assert.match(output, /User:\nSender: alice\nOriginal request/)
    assert.match(output, /User:\nSender: bob\nAdditional request/)
    await engine.commitTurn(turn)
    assert.equal(parseRecallLines(await readFile(path, "utf8")).entries.length, 2)
    // Force a rewrite/prune and verify the structured record survives parsing.
    await engine.commitTurn({ ...turn, advancementKey: "turn-2" })
    const pruned = parseRecallLines(await readFile(path, "utf8"))
    assert.deepEqual(pruned.entries.map((entry) => entry.advancementKey), ["turn-1", "turn-2"])
    assert.ok(pruned.entries.every((entry) => entry.userInputs?.length === 2))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
