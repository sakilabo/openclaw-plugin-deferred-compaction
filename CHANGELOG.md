# Changelog

## 0.1.0 — 2026-09-13

Initial release of Deferred Compaction, giving OpenClaw agents a tool to compact their own context.

### Added

- `compact_context_after_turn`, allowing an agent to compact its own Codex-backed session after the current turn ends.
- Checks for other running Codex sessions before releasing shared app-server connections and starting compaction.
- Completion and failure notifications to the original session, with token counts before and after successful compaction when available.
- Reports of scheduled jobs that overlap compaction, included in the result notification when applicable.
- Configurable waiting, retries, and logging.
