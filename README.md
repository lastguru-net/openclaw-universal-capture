# OpenClaw Universal Capture

`openclaw-universal-capture` is a small OpenClaw context engine that captures
completed user/assistant conversation pairs into append-only Markdown files.

The plugin is intentionally narrow:

- captures assistant text messages paired with the nearest preceding user message
- ignores tool calls, tool results, and non-message transcript records
- writes one combined `Conversation` note per day
- creates the daily file lazily with `Conversation` frontmatter
- strips leading OpenClaw untrusted metadata blocks from captured user messages
  by default
- optionally writes a bounded per-`sessionKey` NDJSON recall buffer
- optionally registers `universal_recall` so agents can recall recent turns from
  the current runtime-provided conversation key
- returns unchanged context from `assemble()`
- returns stable `thread_bootstrap` context projection metadata so native Codex
  threads can resume without lossy per-turn OpenClaw history projection

## Privacy and Retention Warning

This plugin persistently stores completed user/assistant conversations in
append-only workspace files. When recall is enabled, it also stores bounded
per-`sessionKey` NDJSON files containing recent request-response turns.
Captured text can include sensitive prompts, credentials, personal data,
confidential business material, and operational metadata from connected
surfaces.

Before enabling it, operators are responsible for making sure that capture is
appropriate for their users and environment, that users have any required
notice or consent, and that the output folder has suitable filesystem,
backup, sync, and repository access controls. Treat captured files as sensitive
data. Deleting or rotating old records is not automatic unless you add your own
retention process.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "openclaw-universal-capture": {
        "enabled": true,
        "config": {
          "folder": "conversations",
          "recallFolder": "recall",
          "recallTurns": 0,
          "recallMaxBytes": 0,
          "timezone": "Europe/Riga",
          "rolloverTime": "04:00",
          "skipNoReply": false,
          "includeMessageMetadata": false,
          "stripUntrustedMetadata": true,
          "agents": "*",
          "surfaces": "*",
          "channels": "*"
        }
      }
    },
    "slots": {
      "contextEngine": "openclaw-universal-capture"
    }
  }
}
```

`folder` must be relative to the OpenClaw workspace. The default is
`conversations`.

`recallFolder` must be relative to the OpenClaw workspace. The default is
`recall`.

`recallTurns` controls the number of recent request-response turns retained per
`sessionKey`. The default is `0`, which disables recall storage and does not
register the `universal_recall` tool.

`recallMaxBytes` limits both the per-`sessionKey` recall file and the
`universal_recall` tool output. The default is `0`, meaning no plugin-owned byte
limit. Recall files are pruned only by removing whole older NDJSON lines; the
newest captured turn is always retained even if it exceeds the configured byte
limit. Stored lines are not truncated. Tool output may be truncated to respect
the configured limit.

`timezone` controls daily rollover and entry timestamps. The default is the
host timezone.

`rolloverTime` controls when capture switches to the next conversation day in
the configured timezone. The default is `04:00`.

`skipNoReply` controls how turns ending with the assistant text `NO_REPLY` are
handled. By default it is `false`, so those marker replies are written to the
conversation file like any other assistant text. Set it to `true` when you want
to omit turns where `NO_REPLY` means the visible response was delivered through
some other channel or there was intentionally no chat-visible answer.

`includeMessageMetadata` controls whether entry metadata is written directly
below each timestamp heading. The default is `false`. When enabled, the plugin
adds agent, surface, and channel values inferred from `sessionKey`, and adds a
sender line only when the captured user message exposes `senderUsername`.

`stripUntrustedMetadata` controls whether leading OpenClaw envelope metadata is
removed from captured user text. The default is `true`. It strips only when the
user text starts exactly with a `Conversation info (untrusted metadata):` block
using a complete `json` fenced code block. A following `Sender (untrusted
metadata):` fenced block is also stripped. Metadata-like text that appears later
in the message, appears in the opposite order, or does not use that exact
leading structure is preserved.

`agents`, `surfaces`, and `channels` are optional capture filters. Omit a
filter or set it to `*` to capture all values for that dimension. Otherwise,
set it to a comma-separated allow list such as `home,mini`. Prefix the list
with `!` to exclude those values instead, such as `!main,heartbeat`. When more
than one filter is configured, all configured filters must allow the session
for the turn to be captured.

Filter values come from `sessionKey`. `agents` matches the agent name,
`surfaces` matches the surface name, and `channels` matches only the final
sessionKey element. For example,
`agent:home:discord:channel:123456789012345678` has channel filter value
`123456789012345678`, while `agent:main:main:heartbeat` has channel filter
value `heartbeat`.

## Recall Tool

When `recallTurns` is greater than `0`, the plugin registers the
`universal_recall` tool. The tool reads only the recall file for the current
runtime-provided `sessionKey`; it does not accept a model-supplied session
selector.

The tool accepts one optional parameter:

```json
{ "maxTurns": 1 }
```

`maxTurns` limits how many latest request-response turns are returned from the
stored recall window. Omit it or set it to `0` to return the configured default
window. Values larger than the configured/stored window are clamped.

Here, `sessionKey` means OpenClaw's stable conversation routing key, not
necessarily a backend model thread or native runtime session id. For example, a
Discord channel session may keep the same `sessionKey` across `/new` or
`/reset` while the underlying model thread/session id changes. In that case,
`universal_recall` recalls recent turns for the current channel-bound
conversation key.

Agents can call `universal_recall` during startup to retrieve recent
request-response turns after a session reset, or later when context recovery is
needed after compaction. This is best-effort explicit recall, not automatic
prompt injection. It avoids context-projection and native Codex compaction
compatibility problems by letting the agent decide when to request recent
context.

Recall file names use a readable sanitized `sessionKey` slug plus a short hash,
such as
`agent-home-discord-channel-123456789012345678-63b89c15d451.ndjson`, and are
written under `recallFolder`. Each NDJSON line stores:

```json
{
  "timestamp": "2026-06-01T10:05:00.000Z",
  "sessionId": "runtime-session-id",
  "sessionKey": "agent:home:discord:channel:123456789012345678",
  "senderUsername": "operator",
  "userText": "...",
  "assistantText": "..."
}
```

Malformed old NDJSON lines are ignored during recall-file rewrite so a damaged
line does not break future capture. The rewrite salvages valid old entries,
appends the newest turn, prunes from the oldest valid entries, writes a
temporary file, and then renames it into place.

## Output

Daily files are named:

```text
conversations-YYYY-MM-DD.md
```

The file starts as:

```markdown
---
title: conversations-2026-06-01
type: Conversation
permalink: conversations/conversations-2026-06-01
date: 2026-06-01
---

# Conversations 2026-06-01
```

Entries are appended:

```markdown
### 10:05
Agent: home
Surface: discord
Channel: channel:123456789012345678
Sender: operator

**User:**
...

**Assistant:**
...

---
```
