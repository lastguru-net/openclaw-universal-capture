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
  stripLeadingUntrustedMetadata,
} from "../src/capture.js"
import { parseConfig } from "../src/config.js"

function user(text: string, timestamp = Date.UTC(2026, 5, 1, 10, 0)): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp,
  } as AgentMessage
}

function userWithMetadata(
  text: string,
  metadata: Record<string, unknown>,
  timestamp = Date.UTC(2026, 5, 1, 10, 0),
): AgentMessage {
  return {
    ...user(text, timestamp),
    ...metadata,
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

test("parseConfig defaults to host timezone and 04:00 rollover", () => {
  assert.deepEqual(parseConfig({}), {
    folder: "conversations",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: false,
    stripUntrustedMetadata: true,
  })
})

test("parseConfig rejects invalid folder and rollover config", () => {
  assert.throws(() => parseConfig({ folder: "/tmp/captures" }), /workspace-relative/)
  assert.throws(() => parseConfig({ folder: "../captures" }), /inside the workspace/)
  assert.throws(() => parseConfig({ rolloverTime: "4:00" }), /HH:MM/)
  assert.throws(() => parseConfig({ rolloverTime: "24:00" }), /HH:MM/)
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
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: false,
    stripUntrustedMetadata: true,
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

test("selectCaptureEntries uses rollover time for conversation date", () => {
  const entries = selectCaptureEntries({
    messages: [
      user("late question", Date.UTC(2026, 5, 1, 2, 30)),
      assistant("late reply", Date.UTC(2026, 5, 1, 3, 30)),
    ],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: false,
    stripUntrustedMetadata: true,
  })

  assert.deepEqual(entries, [
    {
      date: "2026-05-31",
      time: "03:30",
      userText: "late question",
      assistantText: "late reply",
    },
  ])
})

test("selectCaptureEntries keeps NO_REPLY by default", () => {
  const entries = selectCaptureEntries({
    messages: [user("question"), assistant("NO_REPLY")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: false,
    stripUntrustedMetadata: true,
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.assistantText, "NO_REPLY")
})

test("selectCaptureEntries can skip NO_REPLY", () => {
  const entries = selectCaptureEntries({
    messages: [user("question"), assistant("NO_REPLY")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: true,
    includeMessageMetadata: false,
    stripUntrustedMetadata: true,
  })
  assert.equal(entries.length, 0)
})

test("selectCaptureEntries can include metadata from 5-part session keys", () => {
  const entries = selectCaptureEntries({
    messages: [
      userWithMetadata("question", { senderUsername: "lastguru" }),
      assistant("answer"),
    ],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: true,
    stripUntrustedMetadata: true,
    sessionKey: "agent:home:discord:channel:731682904516293847",
  })

  assert.deepEqual(entries[0]?.metadata, {
    agent: "home",
    surface: "discord",
    channel: "channel:731682904516293847",
    senderUsername: "lastguru",
  })
})

test("selectCaptureEntries can include metadata from 4-part session keys", () => {
  const entries = selectCaptureEntries({
    messages: [user("question"), assistant("answer")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: true,
    stripUntrustedMetadata: true,
    sessionKey: "agent:main:main:heartbeat",
  })

  assert.deepEqual(entries[0]?.metadata, {
    agent: "main",
    surface: "main",
    channel: "heartbeat",
  })
})

test("stripLeadingUntrustedMetadata removes exact leading conversation metadata", () => {
  const text = [
    "Conversation info (untrusted metadata):",
    "```json",
    "{",
    '  "chat_id": "channel:731682904516293847"',
    "}",
    "```",
    "",
    "[OpenClaw heartbeat poll]",
  ].join("\n")

  assert.equal(stripLeadingUntrustedMetadata(text), "[OpenClaw heartbeat poll]")
})

test("stripLeadingUntrustedMetadata removes sender metadata only after conversation metadata", () => {
  const text = [
    "Conversation info (untrusted metadata):",
    "```json",
    "{",
    '  "chat_id": "channel:731682904516293847"',
    "}",
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    "{",
    '  "username": "someone"',
    "}",
    "```",
    "",
    "reply with just \"6\"",
  ].join("\n")

  assert.equal(stripLeadingUntrustedMetadata(text), 'reply with just "6"')
})

test("stripLeadingUntrustedMetadata preserves sender-first and mid-message metadata", () => {
  const senderFirst = [
    "Sender (untrusted metadata):",
    "```json",
    "{}",
    "```",
    "",
    "Conversation info (untrusted metadata):",
    "```json",
    "{}",
    "```",
    "",
    "real message",
  ].join("\n")
  const midMessage = [
    "real prefix",
    "",
    "Conversation info (untrusted metadata):",
    "```json",
    "{}",
    "```",
  ].join("\n")

  assert.equal(stripLeadingUntrustedMetadata(senderFirst), senderFirst)
  assert.equal(stripLeadingUntrustedMetadata(midMessage), midMessage)
})

test("stripLeadingUntrustedMetadata preserves malformed leading metadata", () => {
  const missingFence = [
    "Conversation info (untrusted metadata):",
    "```json",
    "{}",
    "```not-a-closing-fence",
    "",
    "actual message",
  ].join("\n")

  assert.equal(stripLeadingUntrustedMetadata(missingFence), missingFence)
})

test("selectCaptureEntries can keep leading untrusted metadata when disabled", () => {
  const text = [
    "Conversation info (untrusted metadata):",
    "```json",
    "{}",
    "```",
    "",
    "actual message",
  ].join("\n")
  const entries = selectCaptureEntries({
    messages: [user(text), assistant("answer")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: false,
    stripUntrustedMetadata: false,
  })

  assert.equal(entries[0]?.userText, text)
})

test("selectCaptureEntries strips leading untrusted metadata by default config", () => {
  const config = parseConfig({})
  const entries = selectCaptureEntries({
    messages: [
      user(
        [
          "Conversation info (untrusted metadata):",
          "```json",
          "{}",
          "```",
          "",
          "actual message",
        ].join("\n"),
      ),
      assistant("answer"),
    ],
    prePromptMessageCount: 0,
    timezone: config.timezone,
    rolloverTime: config.rolloverTime,
    skipNoReply: config.skipNoReply,
    includeMessageMetadata: config.includeMessageMetadata,
    stripUntrustedMetadata: config.stripUntrustedMetadata,
  })

  assert.equal(entries[0]?.userText, "actual message")
})

test("appendCaptureEntries creates Conversation file frontmatter", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ouc-"))
  try {
    await appendCaptureEntries({
      workspaceDir,
      config: {
        folder: "conversations",
        timezone: "UTC",
        rolloverTime: "04:00",
        skipNoReply: false,
        includeMessageMetadata: true,
        stripUntrustedMetadata: true,
      },
      entries: [
        {
          date: "2026-06-01",
          time: "10:05",
          metadata: {
            agent: "home",
            surface: "discord",
            channel: "channel:731682904516293847",
            senderUsername: "lastguru",
          },
          userText: "new request",
          assistantText: "final reply",
        },
      ],
    })

    const target = resolveCaptureFileTarget({
      workspaceDir,
      folder: "conversations",
      date: "2026-06-01",
    })
    const content = await readFile(target.filePath, "utf8")
    assert.match(content, /type: Conversation/)
    assert.match(
      content,
      /permalink: conversations\/conversations-2026-06-01/,
    )
    assert.match(content, /# Conversations 2026-06-01/)
    assert.match(content, /### 10:05\nAgent: home\nSurface: discord\nChannel: channel:731682904516293847\nSender: lastguru/)
    assert.match(content, /\*\*User:\*\*\nnew request/)
    assert.match(content, /\*\*Assistant:\*\*\nfinal reply/)
  } finally {
    await rm(workspaceDir, { recursive: true, force: true })
  }
})
