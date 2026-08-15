# Changelog

## 0.7.0 - 2026-08-15

- Adopt OpenClaw's durable context-engine turn contract.
- Restore `sessionKey` projection for capture filters, metadata, and Universal Recall.
- Serialize accepted-turn appends and deduplicate completed turns in the daily Markdown log.
- Repair interrupted recall writes on host retry without duplicating turns.
- Update the OpenClaw SDK and minimum Node.js runtime requirements.

## 0.6.0 - 2026-06-09

- Remove the legacy plugin SDK dependency.
- Add the optional `maxTurns` parameter to `universal_recall`.

## 0.5.2 - 2026-06-09

- Clarify that Universal Recall follows OpenClaw's current `sessionKey`, which may outlive a model thread or runtime session.

## 0.5.1 - 2026-06-09

- Add bounded per-`sessionKey` NDJSON recall storage.
- Add the `universal_recall` tool for recovering recent turns after resets or compaction.
- Use readable, collision-resistant recall filenames.

## 0.4.0 - 2026-06-03

- Add agent, surface, and channel capture filters.
- Document capture privacy, retention, and access-control risks.

## 0.3.0 - 2026-06-02

- Add optional stripping of leading OpenClaw untrusted-metadata blocks, enabled by default.
- Keep the context-projection epoch stable across capture-only plugin updates.

## 0.2.1 - 2026-06-02

- Correct OpenClaw peer, build, and Node.js compatibility metadata.

## 0.2.0 - 2026-06-02

- Add optional agent, surface, channel, and sender metadata to captured entries.
- Stop shipping generated build artifacts from the source tree.

## 0.1.0 - 2026-06-01

- Initial release.
- Capture completed user/assistant pairs into daily Markdown conversation notes.
- Add configurable workspace folder, timezone, rollover time, and `NO_REPLY` handling.
