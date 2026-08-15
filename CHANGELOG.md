# Changelog

## 0.7.0

- Adopt OpenClaw's durable context-engine turn contract.
- Capture accepted turns through atomic, idempotent `commitTurn()` processing.
- Restore `sessionKey` projection for capture filters, metadata, and Universal Recall.
- Repair interrupted Markdown or recall projections on host retry without duplicating turns.
- Support the OpenClaw 2026.8 host line starting with 2026.8.1-beta.2.
