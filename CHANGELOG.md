# Changelog

## 0.7.0

- Adopt OpenClaw's durable context-engine turn contract.
- Use the daily Markdown log as the atomic, idempotent accepted-turn record.
- Restore `sessionKey` projection for capture filters, metadata, and Universal Recall.
- Repair interrupted recall projection on host retry without duplicating turns.
- Support the OpenClaw 2026.8 host line starting with 2026.8.1-beta.2.
