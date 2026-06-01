import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import test from "node:test"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import {
  appendCaptureEntries,
  extractMessageText,
  resolveCaptureFileTarget,
  selectCaptureEntries,
} from "../src/capture.js"
import { parseConfig } from "../src/config.js"

function user(text: string, timestamp = Date.UTC(2026, 5, 1, 10, 0)): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp,
  } as AgentMessage
}

function assistant(text: string, timestamp = Date.UTC(2026, 5, 1, 10, 5)): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
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
  } as unknown as AgentMessage
}

function toolOnlyAssistant(timestamp = Date.UTC(2026, 5, 1, 10, 4)): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
    timestamp,
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
    stopReason: "toolUse",
  } as unknown as AgentMessage
}

test("parseConfig defaults to workspace-relative conversation folder and UTC", () => {
  assert.deepEqual(parseConfig({}), {
    folder: "openclaw-beru/conversations",
    timezone: "UTC",
    skipNoReply: false,
  })
})

test("parseConfig rejects absolute and escaping folders", () => {
  assert.throws(() => parseConfig({ folder: "/tmp/captures" }), /workspace-relative/)
  assert.throws(() => parseConfig({ folder: "../captures" }), /inside the workspace/)
})

test("extractMessageText ignores tool calls and keeps text blocks", () => {
  assert.equal(extractMessageText(toolOnlyAssistant()), "")
  assert.equal(extractMessageText(assistant("hello")), "hello")
})

test("selectCaptureEntries captures assistant text with nearest user", () => {
  const messages = [
    user("old"),
    assistant("old reply"),
    user("new request"),
    toolOnlyAssistant(),
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "output" }],
      isError: false,
      timestamp: Date.UTC(2026, 5, 1, 10, 4, 30),
    } as AgentMessage,
    assistant("final reply"),
  ]

  const entries = selectCaptureEntries({
    messages,
    prePromptMessageCount: 2,
    timezone: "UTC",
    skipNoReply: false,
  })

  assert.deepEqual(entries, [
    {
      date: "2026-06-01",
      time: "10:05",
      userText: "new request",
      assistantText: "final reply",
    },
  ])
})

test("selectCaptureEntries keeps NO_REPLY by default", () => {
  const entries = selectCaptureEntries({
    messages: [user("question"), assistant("NO_REPLY")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    skipNoReply: false,
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.assistantText, "NO_REPLY")
})

test("selectCaptureEntries can skip NO_REPLY", () => {
  const entries = selectCaptureEntries({
    messages: [user("question"), assistant("NO_REPLY")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    skipNoReply: true,
  })
  assert.equal(entries.length, 0)
})

test("appendCaptureEntries creates Basic Memory compatible Conversation file", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ouc-"))
  try {
    await appendCaptureEntries({
      workspaceDir,
      config: {
        folder: "openclaw-beru/conversations",
        timezone: "UTC",
        skipNoReply: false,
      },
      entries: [
        {
          date: "2026-06-01",
          time: "10:05",
          userText: "new request",
          assistantText: "final reply",
        },
      ],
    })

    const target = resolveCaptureFileTarget({
      workspaceDir,
      folder: "openclaw-beru/conversations",
      date: "2026-06-01",
    })
    const content = await readFile(target.filePath, "utf8")
    assert.match(content, /type: Conversation/)
    assert.match(
      content,
      /permalink: openclaw-beru\/conversations\/conversations-2026-06-01/,
    )
    assert.match(content, /# Conversations 2026-06-01/)
    assert.match(content, /\*\*User:\*\*\nnew request/)
    assert.match(content, /\*\*Assistant:\*\*\nfinal reply/)
  } finally {
    await rm(workspaceDir, { recursive: true, force: true })
  }
})
