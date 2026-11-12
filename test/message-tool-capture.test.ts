import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import { selectCaptureEntries } from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import { UniversalCaptureContextEngine } from "../src/context-engine.js"
import { parseRecallLines, resolveRecallFilePath } from "../src/recall.js"

const sessionKey = "agent:home:discord:channel:123"
const timestamp = Date.UTC(2026, 10, 12, 10, 0)
const user = { role: "user", content: "question", timestamp }
const commentary = { role: "assistant", content: "commentary", timestamp }
const call = {
  role: "assistant",
  content: [{ type: "toolCall", id: "send-1", name: "message", arguments: {
    action: "send", message: "argument text, not delivered text", final: true,
  } }],
  timestamp,
}
const receipt = {
  role: "toolResult", toolCallId: "send-1", toolName: "message",
  content: [{ type: "text", text: "successful receipt" }], isError: false, timestamp,
}
const finalMirror = {
  role: "assistant",
  content: [{ type: "text", text: "delivered answer" }],
  timestamp,
  openclawDeliveryMirror: {
    kind: "message-tool-source-reply", final: true,
    sourceTurnId: "source-1", toolCallId: "send-1",
  },
}
const progressMirror = {
  ...finalMirror, content: "delivered progress",
  openclawDeliveryMirror: { ...finalMirror.openclawDeliveryMirror, final: false },
}

function select(
  messages: unknown[],
  config: Record<string, unknown> = {},
  prePromptMessageCount = 0,
) {
  return selectCaptureEntries({
    ...parseConfig({ timezone: "UTC", ...config }),
    messages: messages as AgentMessage[], prePromptMessageCount, sessionKey,
  }).map((entry) => entry.assistantText)
}

test("final-only capture selects the delivered mirror before its tool receipt", () => {
  assert.deepEqual(
    select([user, commentary, progressMirror, call, finalMirror, receipt]),
    ["delivered answer"],
  )
})

test("a terminal mirror is selected once whether or not a receipt follows", () => {
  assert.deepEqual(select([user, call, finalMirror]), ["delivered answer"])
  assert.deepEqual(select([user, call, finalMirror, receipt, receipt]), ["delivered answer"])
})

test("delivered final takes precedence over a later silent completion", () => {
  for (const skipNoReply of [false, true]) {
    assert.deepEqual(select([
      user, call, finalMirror, receipt, { ...commentary, content: "NO_REPLY" },
    ], { skipNoReply }), ["delivered answer"])
  }
})

test("the latest final mirror wins without duplicating a later ordinary answer", () => {
  for (const completion of ["latest delivered answer", "unused completion text"]) {
    assert.deepEqual(select([
      user, finalMirror, { ...finalMirror, content: "latest delivered answer" },
      receipt, { ...commentary, content: completion },
    ]), ["latest delivered answer"])
  }
})

test("the host terminal marker does not require a toolCallId", () => {
  assert.deepEqual(select([user, {
    ...finalMirror,
    openclawDeliveryMirror: {
      kind: "message-tool-source-reply", final: true, sourceTurnId: "source-1",
    },
  }, receipt]), ["delivered answer"])
})

for (const [name, mirror] of Object.entries({
  progress: progressMirror,
  "missing final": { ...finalMirror, openclawDeliveryMirror: {
    kind: "message-tool-source-reply", sourceTurnId: "source-1",
  } },
  "string final": { ...finalMirror, openclawDeliveryMirror: {
    ...finalMirror.openclawDeliveryMirror, final: "true",
  } },
  "different kind": { ...finalMirror, openclawDeliveryMirror: {
    ...finalMirror.openclawDeliveryMirror, kind: "other",
  } },
  "missing source turn": { ...finalMirror, openclawDeliveryMirror: {
    kind: "message-tool-source-reply", final: true,
  } },
  "blank source turn": { ...finalMirror, openclawDeliveryMirror: {
    ...finalMirror.openclawDeliveryMirror, sourceTurnId: "  ",
  } },
  "non-string source turn": { ...finalMirror, openclawDeliveryMirror: {
    ...finalMirror.openclawDeliveryMirror, sourceTurnId: 1,
  } },
  "array metadata": { ...finalMirror, openclawDeliveryMirror: [] },
  "non-assistant role": { ...finalMirror, role: "toolResult" },
  "unmarked narration": commentary,
})) {
  test(`does not promote ${name} before a receipt to a final answer`, () => {
    assert.deepEqual(select([user, mirror, receipt]), [])
    if ("openclawDeliveryMirror" in mirror &&
        "kind" in mirror.openclawDeliveryMirror &&
        mirror.openclawDeliveryMirror.kind === "message-tool-source-reply") {
      assert.deepEqual(select([user, mirror]), [])
    }
  })
}

test("a progress mirror at the end is not a final answer", () => {
  assert.deepEqual(select([user, progressMirror]), [])
})

test("progress followed by an ordinary final still captures the ordinary answer", () => {
  assert.deepEqual(select([
    user, commentary, progressMirror, receipt,
    { ...commentary, content: "ordinary answer" },
  ]), ["ordinary answer"])
})

test("does not reconstruct a final answer from tool arguments or receipts", () => {
  assert.deepEqual(select([user, call, receipt]), [])
})

test("does not select a final mirror from before the current range or latest user", () => {
  assert.deepEqual(select([user, finalMirror, receipt], {}, 2), [])
  assert.deepEqual(select([user, finalMirror, user, call, receipt]), [])
  assert.deepEqual(select([finalMirror, receipt]), [])
  assert.deepEqual(select([user, finalMirror, receipt], {}, 3), [])
})

test("empty or filtered final mirrors do not fall back to other assistant text", () => {
  assert.deepEqual(select([user, commentary, { ...finalMirror, content: " " }, receipt]), [])
  assert.deepEqual(select([
    user, finalMirror, { ...finalMirror, content: "NO_REPLY" }, receipt,
  ], { skipNoReply: true }), [])
  assert.deepEqual(select([
    user, { ...finalMirror, content: "NO_REPLY" }, receipt,
  ]), ["NO_REPLY"])
  assert.deepEqual(select([user, finalMirror, receipt], { channels: "!123" }), [])
})

test("commentary mode still captures all assistant text including progress and finals", () => {
  assert.deepEqual(select([
    user, commentary, progressMirror, call, finalMirror, receipt,
  ], { commentary: true }), ["commentary", "delivered progress", "delivered answer"])
})

for (const commentaryEnabled of [false, true]) {
  test(`commitTurn writes message-tool replies to Markdown and recall (commentary:${commentaryEnabled})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ouc-message-tool-"))
    try {
      const engine = new UniversalCaptureContextEngine({
        workspaceDir: root,
        config: parseConfig({ timezone: "UTC", recallTurns: 10, commentary: commentaryEnabled }),
      })
      const scope = {
        agentId: "home", sessionId: "session-1", sessionKey,
        storePath: join(root, "store.sqlite"), generation: "generation-1",
      }
      const messages = [user, commentary, progressMirror, call, finalMirror, receipt]
      assert.deepEqual(await engine.commitTurn({
        advancementKey: "advancement-1", sessionId: scope.sessionId, sessionKey,
        messages: messages as AgentMessage[],
        admission: {
          ...scope, entryId: "user-1", rawSeq: 1, effectiveParentId: null,
          activeMessagePosition: 0, logicalTurnId: "source-1", role: "user",
        },
        terminal: {
          ...scope, entryId: "receipt-1", rawSeq: messages.length,
          effectiveParentId: "mirror-1", activeMessagePosition: messages.length - 1,
        },
      }), { status: "committed" })

      const expected = commentaryEnabled
        ? ["commentary", "delivered progress", "delivered answer"]
        : ["delivered answer"]
      const markdown = await readFile(join(root, "conversations", "conversations-2026-11-12.md"), "utf8")
      assert.equal(markdown.split("**Assistant:**").length - 1, expected.length)
      assert.equal(markdown.split("delivered answer").length - 1, 1)
      assert.doesNotMatch(markdown, /successful receipt|argument text/)
      if (!commentaryEnabled) assert.doesNotMatch(markdown, /commentary|delivered progress/)
      const recall = parseRecallLines(await readFile(resolveRecallFilePath({
        workspaceDir: root, recallFolder: "recall", sessionKey,
      }), "utf8"))
      assert.deepEqual(recall.entries.map((entry) => entry.assistantText), expected)
      assert.ok(recall.entries.every((entry) => entry.userText === "question"))
      assert.ok(recall.entries.every((entry) => entry.advancementKey === "advancement-1"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
