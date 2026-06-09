import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import assert from "node:assert/strict"
import test from "node:test"

import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime"

import {
  appendCaptureEntries,
  extractMessageText,
  resolveCaptureFileTarget,
  selectCaptureEntries as selectCaptureEntriesBase,
  stripLeadingUntrustedMetadata,
} from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import {
  createUniversalRecallTool,
  parseRecallLines,
  renderRecallToolOutput,
  resolveRecallToolMaxTurns,
  resolveRecallFilePath,
  writeRecallEntries,
} from "../src/recall.js"

type SelectCaptureEntriesParams = Parameters<typeof selectCaptureEntriesBase>[0]

function selectCaptureEntries(
  params: Omit<SelectCaptureEntriesParams, "agents" | "surfaces" | "channels"> &
    Partial<Pick<SelectCaptureEntriesParams, "agents" | "surfaces" | "channels">>,
) {
  const config = parseConfig({})
  return selectCaptureEntriesBase({
    ...params,
    agents: params.agents ?? config.agents,
    surfaces: params.surfaces ?? config.surfaces,
    channels: params.channels ?? config.channels,
  })
}

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
    recallFolder: "recall",
    recallTurns: 0,
    recallMaxBytes: 0,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: false,
    stripUntrustedMetadata: true,
    agents: { mode: "all", values: new Set<string>() },
    surfaces: { mode: "all", values: new Set<string>() },
    channels: { mode: "all", values: new Set<string>() },
  })
})

test("parseConfig rejects invalid folder and rollover config", () => {
  assert.throws(() => parseConfig({ folder: "/tmp/captures" }), /workspace-relative/)
  assert.throws(() => parseConfig({ folder: "../captures" }), /inside the workspace/)
  assert.throws(() => parseConfig({ recallFolder: "/tmp/recall" }), /workspace-relative/)
  assert.throws(() => parseConfig({ recallFolder: "../recall" }), /inside the workspace/)
  assert.throws(() => parseConfig({ rolloverTime: "4:00" }), /HH:MM/)
  assert.throws(() => parseConfig({ rolloverTime: "24:00" }), /HH:MM/)
  assert.throws(() => parseConfig({ recallTurns: -1 }), /recallTurns/)
  assert.throws(() => parseConfig({ recallTurns: 1.5 }), /recallTurns/)
  assert.throws(() => parseConfig({ recallMaxBytes: -1 }), /recallMaxBytes/)
})

test("parseConfig supports include, exclude, and wildcard capture filters", () => {
  const config = parseConfig({
    agents: "home, mini",
    surfaces: "!main,heartbeat",
    channels: "*",
  })

  assert.equal(config.agents.mode, "include")
  assert.deepEqual([...config.agents.values], ["home", "mini"])
  assert.equal(config.surfaces.mode, "exclude")
  assert.deepEqual([...config.surfaces.values], ["main", "heartbeat"])
  assert.equal(config.channels.mode, "all")
  assert.deepEqual([...config.channels.values], [])
})

test("parseConfig rejects non-string capture filters", () => {
  assert.throws(() => parseConfig({ agents: ["home"] }), /agents must be a string/)
  assert.throws(() => parseConfig({ surfaces: true }), /surfaces must be a string/)
  assert.throws(() => parseConfig({ channels: 123456789012345678 }), /channels must be a string/)
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
      timestamp: "2026-06-01T10:05:00.000Z",
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
      timestamp: "2026-06-01T03:30:00.000Z",
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
      userWithMetadata("question", { senderUsername: "operator" }),
      assistant("answer"),
    ],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: true,
    stripUntrustedMetadata: true,
    sessionKey: "agent:home:discord:channel:123456789012345678",
  })

  assert.deepEqual(entries[0]?.metadata, {
    agent: "home",
    surface: "discord",
    channel: "channel:123456789012345678",
    senderUsername: "operator",
  })
  assert.equal(entries[0]?.senderUsername, "operator")
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

test("selectCaptureEntries filters by included agent surface and channel id", () => {
  const config = parseConfig({
    agents: "home,mini",
    surfaces: "discord",
    channels: "123456789012345678",
  })

  const captured = selectCaptureEntries({
    messages: [user("question"), assistant("answer")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: true,
    stripUntrustedMetadata: true,
    agents: config.agents,
    surfaces: config.surfaces,
    channels: config.channels,
    sessionKey: "agent:home:discord:channel:123456789012345678",
  })
  const skippedByChannel = selectCaptureEntries({
    messages: [user("question"), assistant("answer")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: true,
    stripUntrustedMetadata: true,
    agents: config.agents,
    surfaces: config.surfaces,
    channels: config.channels,
    sessionKey: "agent:home:discord:channel:999999999999999999",
  })

  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.metadata?.channel, "channel:123456789012345678")
  assert.equal(skippedByChannel.length, 0)
})

test("selectCaptureEntries filters 4-part session keys by their last element", () => {
  const config = parseConfig({
    agents: "main",
    surfaces: "main",
    channels: "heartbeat",
  })

  const entries = selectCaptureEntries({
    messages: [user("question"), assistant("answer")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: true,
    stripUntrustedMetadata: true,
    agents: config.agents,
    surfaces: config.surfaces,
    channels: config.channels,
    sessionKey: "agent:main:main:heartbeat",
  })

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.metadata?.channel, "heartbeat")
})

test("selectCaptureEntries combines negated filters with positive filters", () => {
  const config = parseConfig({
    agents: "!main",
    surfaces: "discord",
    channels: "!123456789012345678",
  })

  const allowed = selectCaptureEntries({
    messages: [user("question"), assistant("answer")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: false,
    stripUntrustedMetadata: true,
    agents: config.agents,
    surfaces: config.surfaces,
    channels: config.channels,
    sessionKey: "agent:mini:discord:channel:642918573406128735",
  })
  const blockedAgent = selectCaptureEntries({
    messages: [user("question"), assistant("answer")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: false,
    stripUntrustedMetadata: true,
    agents: config.agents,
    surfaces: config.surfaces,
    channels: config.channels,
    sessionKey: "agent:main:discord:channel:642918573406128735",
  })
  const blockedChannel = selectCaptureEntries({
    messages: [user("question"), assistant("answer")],
    prePromptMessageCount: 0,
    timezone: "UTC",
    rolloverTime: "04:00",
    skipNoReply: false,
    includeMessageMetadata: false,
    stripUntrustedMetadata: true,
    agents: config.agents,
    surfaces: config.surfaces,
    channels: config.channels,
    sessionKey: "agent:mini:discord:channel:123456789012345678",
  })

  assert.equal(allowed.length, 1)
  assert.equal(blockedAgent.length, 0)
  assert.equal(blockedChannel.length, 0)
})

test("stripLeadingUntrustedMetadata removes exact leading conversation metadata", () => {
  const text = [
    "Conversation info (untrusted metadata):",
    "```json",
    "{",
    '  "chat_id": "channel:123456789012345678"',
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
    '  "chat_id": "channel:123456789012345678"',
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

test("writeRecallEntries writes safe per-session ndjson and prunes by turn count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "universal-capture-recall-"))
  try {
    const config = parseConfig({ recallTurns: 2, recallFolder: "recall" })
    const sessionKey = "agent:home:discord:channel:123456789012345678"
    const entries = selectCaptureEntries({
      messages: [
        user("one", Date.UTC(2026, 5, 1, 10, 0)),
        assistant("first", Date.UTC(2026, 5, 1, 10, 1)),
        user("two", Date.UTC(2026, 5, 1, 10, 2)),
        assistant("second", Date.UTC(2026, 5, 1, 10, 3)),
        user("three", Date.UTC(2026, 5, 1, 10, 4)),
        assistant("third", Date.UTC(2026, 5, 1, 10, 5)),
      ],
      prePromptMessageCount: 0,
      timezone: "UTC",
      rolloverTime: "04:00",
      skipNoReply: false,
      includeMessageMetadata: false,
      stripUntrustedMetadata: true,
      sessionKey,
    })

    await writeRecallEntries({
      workspaceDir: dir,
      config,
      sessionId: "session-a",
      sessionKey,
      entries,
    })

    const recallPath = resolveRecallFilePath({
      workspaceDir: dir,
      recallFolder: config.recallFolder,
      sessionKey,
    })
    assert.match(
      recallPath,
      /recall\/agent-home-discord-channel-123456789012345678-[a-f0-9]{12}\.ndjson$/,
    )
    assert.doesNotMatch(recallPath, /agent:home/)

    const parsed = parseRecallLines(await readFile(recallPath, "utf8"))
    assert.equal(parsed.malformedLines, 0)
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.userText, entry.assistantText]),
      [
        ["two", "second"],
        ["three", "third"],
      ],
    )
    assert.equal(parsed.entries[0]?.sessionId, "session-a")
    assert.equal(parsed.entries[0]?.sessionKey, sessionKey)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("writeRecallEntries salvages valid ndjson and ignores malformed old lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "universal-capture-recall-"))
  try {
    const config = parseConfig({ recallTurns: 3, recallFolder: "recall" })
    const sessionKey = "agent:home:discord:channel:123456789012345678"
    const recallPath = resolveRecallFilePath({
      workspaceDir: dir,
      recallFolder: config.recallFolder,
      sessionKey,
    })
    await mkdir(dirname(recallPath), { recursive: true })
    await writeFile(
      recallPath,
      [
        JSON.stringify({
          timestamp: "2026-06-01T09:00:00.000Z",
          sessionKey,
          userText: "valid old",
          assistantText: "valid reply",
        }),
        "{not json",
        JSON.stringify({ timestamp: "missing fields" }),
        "",
      ].join("\n"),
      "utf8",
    )

    const entries = selectCaptureEntries({
      messages: [user("new"), assistant("new reply")],
      prePromptMessageCount: 0,
      timezone: "UTC",
      rolloverTime: "04:00",
      skipNoReply: false,
      includeMessageMetadata: false,
      stripUntrustedMetadata: true,
      sessionKey,
    })
    const result = await writeRecallEntries({
      workspaceDir: dir,
      config,
      sessionKey,
      entries,
    })

    assert.equal(result.malformedLines, 2)
    const parsed = parseRecallLines(await readFile(recallPath, "utf8"))
    assert.equal(parsed.malformedLines, 0)
    assert.deepEqual(
      parsed.entries.map((entry) => entry.userText),
      ["valid old", "new"],
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("writeRecallEntries keeps newest line even when byte limit is smaller", async () => {
  const dir = await mkdtemp(join(tmpdir(), "universal-capture-recall-"))
  try {
    const config = parseConfig({ recallTurns: 5, recallMaxBytes: 20 })
    const sessionKey = "agent:home:discord:channel:123456789012345678"
    const entries = selectCaptureEntries({
      messages: [user("newest question"), assistant("newest reply with many bytes")],
      prePromptMessageCount: 0,
      timezone: "UTC",
      rolloverTime: "04:00",
      skipNoReply: false,
      includeMessageMetadata: false,
      stripUntrustedMetadata: true,
      sessionKey,
    })

    await writeRecallEntries({
      workspaceDir: dir,
      config,
      sessionKey,
      entries,
    })

    const parsed = parseRecallLines(
      await readFile(
        resolveRecallFilePath({
          workspaceDir: dir,
          recallFolder: config.recallFolder,
          sessionKey,
        }),
        "utf8",
      ),
    )
    assert.equal(parsed.entries.length, 1)
    assert.equal(parsed.entries[0]?.assistantText, "newest reply with many bytes")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("renderRecallToolOutput truncates output without corrupting utf8", () => {
  const text = renderRecallToolOutput({
    entries: [
      {
        timestamp: "2026-06-01T10:05:00.000Z",
        sessionKey: "agent:home:discord:channel:123456789012345678",
        senderUsername: "operator",
        userText: "question",
        assistantText: "answer with utf8 āāāāā",
      },
    ],
    malformedLines: 1,
    recallMaxBytes: 80,
  })

  assert.match(text, /truncated by recallMaxBytes/)
  assert.doesNotMatch(text, /\uFFFD/)
})

test("resolveRecallToolMaxTurns uses default for omitted or zero and validates input", () => {
  assert.equal(resolveRecallToolMaxTurns({ rawParams: undefined, defaultTurns: 3 }), 3)
  assert.equal(resolveRecallToolMaxTurns({ rawParams: {}, defaultTurns: 3 }), 3)
  assert.equal(resolveRecallToolMaxTurns({ rawParams: { maxTurns: 0 }, defaultTurns: 3 }), 3)
  assert.equal(resolveRecallToolMaxTurns({ rawParams: { maxTurns: 1 }, defaultTurns: 3 }), 1)
  assert.equal(resolveRecallToolMaxTurns({ rawParams: { maxTurns: 9 }, defaultTurns: 3 }), 3)
  assert.throws(
    () => resolveRecallToolMaxTurns({ rawParams: { maxTurns: -1 }, defaultTurns: 3 }),
    /non-negative integer/,
  )
  assert.throws(
    () => resolveRecallToolMaxTurns({ rawParams: { maxTurns: 1.5 }, defaultTurns: 3 }),
    /non-negative integer/,
  )
  assert.throws(
    () => resolveRecallToolMaxTurns({ rawParams: { extra: true }, defaultTurns: 3 }),
    /unknown parameter/,
  )
})

test("createUniversalRecallTool limits output with optional maxTurns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "universal-capture-recall-tool-"))
  try {
    const config = parseConfig({ recallTurns: 3, recallFolder: "recall" })
    const sessionKey = "agent:home:discord:channel:123456789012345678"
    const entries = selectCaptureEntries({
      messages: [
        user("one", Date.UTC(2026, 5, 1, 10, 0)),
        assistant("first", Date.UTC(2026, 5, 1, 10, 1)),
        user("two", Date.UTC(2026, 5, 1, 10, 2)),
        assistant("second", Date.UTC(2026, 5, 1, 10, 3)),
        user("three", Date.UTC(2026, 5, 1, 10, 4)),
        assistant("third", Date.UTC(2026, 5, 1, 10, 5)),
      ],
      prePromptMessageCount: 0,
      timezone: "UTC",
      rolloverTime: "04:00",
      skipNoReply: false,
      includeMessageMetadata: false,
      stripUntrustedMetadata: true,
      sessionKey,
    })
    await writeRecallEntries({
      workspaceDir: dir,
      config,
      sessionKey,
      entries,
    })

    const tool = createUniversalRecallTool({
      config,
      context: { workspaceDir: dir, sessionKey } as never,
    })
    const latestOnly = await tool.execute("call-1", { maxTurns: 1 })
    const latestText = latestOnly.content[0]?.text ?? ""
    assert.doesNotMatch(latestText, /User:\none/)
    assert.doesNotMatch(latestText, /User:\ntwo/)
    assert.match(latestText, /User:\nthree/)

    const defaultWindow = await tool.execute("call-2", { maxTurns: 0 })
    const defaultText = defaultWindow.content[0]?.text ?? ""
    assert.match(defaultText, /User:\none/)
    assert.match(defaultText, /User:\ntwo/)
    assert.match(defaultText, /User:\nthree/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("appendCaptureEntries creates Conversation file frontmatter", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ouc-"))
  try {
    await appendCaptureEntries({
      workspaceDir,
      config: {
        folder: "conversations",
        recallFolder: "recall",
        recallTurns: 0,
        recallMaxBytes: 0,
        timezone: "UTC",
        rolloverTime: "04:00",
        skipNoReply: false,
        includeMessageMetadata: true,
        stripUntrustedMetadata: true,
        agents: { mode: "all", values: new Set<string>() },
        surfaces: { mode: "all", values: new Set<string>() },
        channels: { mode: "all", values: new Set<string>() },
      },
      entries: [
        {
          date: "2026-06-01",
          time: "10:05",
          timestamp: "2026-06-01T10:05:00.000Z",
          metadata: {
            agent: "home",
            surface: "discord",
            channel: "channel:123456789012345678",
            senderUsername: "operator",
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
    assert.match(content, /### 10:05\nAgent: home\nSurface: discord\nChannel: channel:123456789012345678\nSender: operator/)
    assert.match(content, /\*\*User:\*\*\nnew request/)
    assert.match(content, /\*\*Assistant:\*\*\nfinal reply/)
  } finally {
    await rm(workspaceDir, { recursive: true, force: true })
  }
})
