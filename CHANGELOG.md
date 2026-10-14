# Changelog

## 0.2.0 — 2026-10-14

### Added

- `request_context_compaction`, an optional tool that asks another session to compact its context. It returns once the request is accepted and delivers it in the Gateway process, so cron trigger scripts can call it within their evaluation budget.

### Changed

- Include CLI startup acceleration in the plugin and propagate it to runtime workers. Compaction and result notifications no longer depend on external Gateway startup hooks.
- Remove configured-MCP diagnostic notice generation from CLI subprocesses. Tool omissions and startup discovery diagnostics no longer add model instructions or reject automation saves through that notice. No replacement prompt is added.
- Require the publication tag to match the package version, publish under the `sakilabo` owner, and run regression tests before publication.

### Fixed

- Allow accelerated loading of non-bundled plugins that provide a source digest, while retaining the original condition for bundled modules.
- Support the plugin loader condition of OpenClaw `2026.10.3` in CLI startup acceleration, so JavaScript plugins load directly.
- Apply the startup import to both branches of the SQLite worker preload rule.

## 0.1.0 — 2026-09-13

Initial release of Deferred Compaction, giving OpenClaw agents a tool to compact their own context.

### Added

- `compact_context_after_turn`, allowing an agent to compact its own Codex-backed session after the current turn ends.
- Checks for other running Codex sessions before releasing shared app-server connections and starting compaction.
- Completion and failure notifications to the original session, with token counts before and after successful compaction when available.
- Reports of scheduled jobs that overlap compaction, included in the result notification when applicable.
- Configurable waiting, retries, and logging.
