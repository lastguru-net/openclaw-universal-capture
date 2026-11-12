# Changelog

## 0.8.0 - 2026-11-12

- Fix final-only capture dropping confirmed message-tool replies when a tool receipt or completion text follows the delivered answer.
- Fix final-only capture incorrectly recording a message-tool progress mirror when it is the last transcript row.
- Preserve the host-resolved session target and runtime context when delegating compaction, including the active workspace and configuration.
- Update the OpenClaw development SDK/build target to 2026.11.3, TypeScript to 7.0.2, and Node.js 24 types to 24.19.2; refresh the dependency lockfile.
- Require OpenClaw 2026.11.3 or newer and align Node.js requirements with that host: `>=24.16.0 <25 || >=26.1.0`.

## 0.7.1 - 2026-08-20

- Capture only the accepted terminal assistant message by default.
- Add the `commentary` option; set it to `true` to preserve version 0.7.0's all-assistant-text behavior.
- Apply `skipNoReply` after terminal selection so omitted terminal markers never fall back to earlier commentary or plan text.
- Clean generated output before builds so removed source modules cannot leak into release tarballs.

## 0.7.0 - 2026-08-15

- Adopt OpenClaw's current accepted-turn context-engine API and transcript fencing declaration.
- Restore `sessionKey` projection for capture filters, metadata, and Universal Recall.
- Write Universal Recall before directly appending the turn to the daily Markdown log.
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
