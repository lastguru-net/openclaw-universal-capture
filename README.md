# OpenClaw Universal Capture

`openclaw-universal-capture` is a small OpenClaw context engine that captures
completed user/assistant conversation pairs into append-only Markdown files.

Version `0.3.0` is intentionally narrow:

- captures assistant text messages paired with the nearest preceding user message
- ignores tool calls, tool results, and non-message transcript records
- writes one combined `Conversation` note per day
- creates the daily file lazily with `Conversation` frontmatter
- strips leading OpenClaw untrusted metadata blocks from captured user messages
  by default
- returns unchanged context from `assemble()`
- returns stable `thread_bootstrap` context projection metadata so native Codex
  threads can resume without lossy per-turn OpenClaw history projection

## Configuration

```json
{
  "plugins": {
    "entries": {
      "openclaw-universal-capture": {
        "enabled": true,
        "config": {
          "folder": "conversations",
          "timezone": "Europe/Riga",
          "rolloverTime": "04:00",
          "skipNoReply": false,
          "includeMessageMetadata": false,
          "stripUntrustedMetadata": true
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
Channel: channel:731682904516293847
Sender: lastguru

**User:**
...

**Assistant:**
...

---
```
