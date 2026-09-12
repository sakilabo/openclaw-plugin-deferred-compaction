# Deferred Compaction

**This plugin lets an OpenClaw agent compact its own context.**

It adds a `compact_context_after_turn` tool to OpenClaw agents running on the Codex harness. When an agent calls the tool, the plugin compacts the context of the same session after the current turn ends.

The central problem this plugin solves is not when or how often compaction runs. **By default, an agent cannot execute context compaction itself.** Giving the agent that ability enables workflows such as:

- Compacting its own context automatically once a day
- Compacting when it decides that its context has grown too large
- Compacting when instructed to do so by the user

"Once a day" is only an example. It does not mean that this plugin runs on a fixed schedule. This plugin is not a scheduler; it gives OpenClaw agents the context-compaction capability they otherwise lack.

## Supported versions and requirements

- Tested with OpenClaw `2026.9.4`
- Tested with `@openclaw/codex@2026.9.4`
- Supports sessions where `session_windows.agent_harness_id = 'codex'`
- Does not support sessions using other harnesses
- Other versions have not been tested

This plugin depends on internal OpenClaw and Codex plugin implementation details. Compatibility must therefore be checked after updating OpenClaw or `@openclaw/codex`. In particular, it uses the disposer symbol on `globalThis`, the `session_windows` and `cron_run_receipts` schemas, the agent and state directory layouts, and the `sessions.compact` and `chat.send` Gateway RPC methods.

## Why this plugin is needed

### Problem 1: Agents cannot execute compaction

OpenClaw provides `/codex compact` for users to enter. However, it is a chat command, not a tool that an agent can call. The `openclaw sessions compact` CLI command is likewise not exposed as a context-compaction tool for agents.

Consequently, a standard agent may determine that it has not compacted today or that its context has grown too large, but it still cannot perform the compaction itself. Writing an automatic-execution rule or instruction is not enough; the agent needs an actual compaction tool that it can call.

This plugin fills that gap by adding `compact_context_after_turn`.

### Problem 2: Users cannot tell when manual compaction will succeed

As an alternative to automatic execution by the agent, a user could run `/codex compact` manually. At present, however, even that cannot be executed reliably.

For a Codex-harness session, compaction is handled by the Codex app server's `thread/compact/start`, not by OpenClaw itself. Compaction succeeds only while the Codex app server does not hold the thread writer. Because the connection that executed a turn continues to hold the writer after the turn ends, users cannot tell when `/codex compact` will succeed.

This is a problem in the current integration between OpenClaw and the Codex harness and may be fixed in the future. This plugin also works around the current problem by releasing the connection before compaction.

## How it works

When the agent calls `compact_context_after_turn`, the plugin performs the following steps. An agent cannot replace its own context in the middle of a turn, so compaction is deferred until the turn ends. Reserving compaction is the implementation mechanism; the purpose is to let the agent compact its own context.

1. While the tool is running within the normal turn, wait up to `idleWaitMs` (10 seconds by default) for other Codex sessions to finish. If the wait expires, return a tool error without reserving compaction.
2. Read the pre-compaction token count through the Plugin Runtime API and reserve compaction.
3. After `agent_end`, wait for `delayMs` (1.5 seconds by default), then check the session state again. If another session conflicts, wait up to `postTurnIdleWaitMs` (15 seconds by default). If it is still running, treat the compaction as failed.
4. Close the Codex app-server connections for all agents and release the thread writer locks. The connections are recreated on the next turn.
5. Run `sessions compact --json` through the OpenClaw CLI.
6. Log the compaction result and the token counts before and after compaction.
7. Whether compaction succeeds or fails, send a message to the original session through `chat.send`.

All waiting is designed to occur within the turn. Once `agent_end` has fired, the turn is already over and the plugin cannot wait indefinitely; a conflict at that point is treated as a failed attempt.

Reservation state is shared in process memory through `globalThis`. Reservations are shared even if OpenClaw loads the plugin as multiple registration instances, and they are discarded automatically when the Gateway restarts. They are not persisted to a file or database.

## Session notifications

Because compaction runs after the turn ends, the agent cannot continue without learning the result. The reservation and completion notifications therefore form a pair.

| Event | Recipient | Message |
| --- | --- | --- |
| Reserved (tool result) | Agent | Session compaction is reserved. Tell the user to wait: this session will be unavailable for one to two minutes, until compaction finishes. |
| Completed | Session | Session compaction finished.<br>Context tokens: 58352 -> 28436 of 258400. |
| Failed | Session | Session compaction failed. Reason: …<br>The context is left uncompacted.<br>Do not run compaction again. |

The completion message includes the token counts before and after compaction and the session's context window. This prevents the agent from having to look up the result itself. If neither token count can be obtained, the line is omitted. If only one is available, only that value is reported, as in `Context tokens after compaction: …`.

### Scheduled jobs that overlap compaction

Compaction releases the Codex app-server connection and occupies the session. A scheduled job starting at almost the same time can therefore be affected. Because that run occurs outside the agent's own turn, the session would not know about it without a notification.

The plugin reads `cron_run_receipts` in the state database to find runs for the same agent that overlap the compaction window, from the beginning of deferred execution until immediately before notification. Only receipts with the `skipped` status are excluded. That status means the trigger condition was not met and no run took place, so excluding it does not omit an actual execution.

The plugin does not filter by any other status because a receipt records only the job's own outcome, not whether it overlapped compaction. A run affected by compaction may still finish successfully and be recorded as `ok`. Filtering by status would hide exactly the cases that need review.

When overlapping runs exist, the following lines are appended to the completion or failure message:

```
1 scheduled job ran while compaction was running:
- job 2eb04408-e4ff-4ac7-8292-1da118e3db31: ok
Confirm that compaction caused no problem for it before resuming your work.
```

The final line identifies both what to inspect—the listed job runs—and why—to determine whether compaction caused a problem. Without it, the receiving agent would have to infer why the list was included.

If no runs overlap, nothing is appended and the message reports only the compaction result.

The state database path is resolved with the plugin SDK's `resolveStateDir`, and `state/openclaw.sqlite` is opened read-only. A read failure does not prevent the notification from being sent, because failing to announce that compaction has ended would be more harmful. Such failures are recorded as `compaction_window_jobs_failed`.

Completion and failure messages are sent through the Gateway RPC method `chat.send` with `deliver: true`. The in-process `dispatchGatewayMethod` is available only within the scope of authenticated plugin HTTP routes, so this plugin invokes it through the OpenClaw CLI (`gateway call chat.send`), as it does for compaction. The message becomes session input, starts one agent turn, and delivers the resulting reply to the channel.

The plugin uses `chat.send` rather than `sessions.send` because `sessions.send` cannot carry a delivery option. It delegates a fixed set of parameters to `chat.send`; without `deliver`, the reply is routed to the internal message channel. The turn still runs, but the response reaches only Gateway subscribers such as Control UI and is not delivered to an external channel. With `deliver: true`, OpenClaw resolves the destination from the session's own delivery context, keeping the plugin independent of any particular channel type. Sessions without an external route, including Control UI and WebChat sessions, continue to record the response only in the transcript. Because `chat.send` requires an `idempotencyKey`, the plugin generates a UUID for every send.

A notification is always sent after failure as well. Otherwise, an agent instructed to wait for the next notification would wait indefinitely. The failure message prevents automatic retries. This is the only notification route; the plugin does not send a separate direct message to the user.

## Causes of compaction failure and how they are handled

`openclaw sessions compact` calls the Gateway RPC method `sessions.compact`. For a Codex-harness session, this goes through the Codex app server's `thread/resume`. If the app-server connection that ran the turn still holds the thread, the resume fails with `thread-store conflict: thread <id> already has an active writer`. The writer can remain held for up to 30 minutes (`CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS`), so compaction immediately after a turn always fails.

Before compaction, the plugin therefore calls the disposer exposed by the Codex plugin on `globalThis`: `Symbol.for("openclaw.codexAppServerClientDisposer@<version>")`, whose implementation is `clearSharedCodexAppServerClientAndWait`. This is the same function used by the Codex harness during disposal. It closes the shared app-server client and waits for the process to exit.

Because this releases the Codex connections for every agent, the plugin performs the following read-only check first to avoid interrupting active turns:

- No session other than the compaction target has both `agent_harness_id = 'codex'` and `status = 'running'` in the `session_windows` table of any agent's `agents\<id>\agent\openclaw-agent.sqlite` database.

Agents are enumerated with `listAgentIds()`. It returns the default agent ID when `agents.entries` is empty, so no specific agent ID needs to be added as a fallback.

The disposer waits for the app-server process to exit, so the release is complete when it returns. Files matching `agents\<id>\agent\codex-home\thread-writer-locks\*.lock` are listed in the logs before and after release but are not used for the decision. A stale file may remain after a forced termination, so its presence does not prove that a writer is active.

The `status` column represents whether a run is alive. OpenClaw writes `running` together with `startedAt` when accepting a run, then changes it to `done` together with `endedAt` and `runtimeMs` when the run ends. The status column is therefore sufficient for the activity check.

The plugin checks for idle sessions every `idlePollMs` (one second by default). Each compaction retry, controlled by `compactAttempts` (three by default), restarts from the same state check and uses `idlePollMs` as its interval. A retry checks immediately without waiting; if another Codex session is active, the attempt fails at that point.

Compaction itself takes approximately one minute. In one measurement, completion occurred about 80 seconds after `agent_end`: releasing the connection took 0.1 seconds and `sessions compact` took approximately 67 seconds. This is why the tool result tells the agent to expect one to two minutes.

If another message enters the session queue during compaction, `sessions.compact` rejects the operation with `Session <key> has queued work; retry after it finishes.` The plugin can ask the agent to wait, but it cannot prevent a user from sending another message, so this failure remains possible.

## Build

```powershell
npm install --legacy-peer-deps
npm run build
```

Types are resolved from the `openclaw` package. To use a globally installed OpenClaw instead of downloading it, you can link it:

```powershell
npm link openclaw
npm run build
```

In VS Code, open `deferred-compaction.code-workspace` and run the default build task. After building, reload the plugin on the Gateway before testing the new build.

### Windows

When linking a globally installed OpenClaw with `npm link openclaw`, use Git Bash. PowerShell may reject the resulting junction as an "untrusted mount point" and fail to resolve imports from the OpenClaw Plugin SDK. Type-checking and building with the same junction have been confirmed to work in Git Bash.

```bash
npm install --legacy-peer-deps
npm link openclaw
npm run typecheck
npm run build
```

## Logging

The default log file is `logs/deferred-compaction.log`. It uses JSON Lines format and is always truncated to the latest 500 lines. `logLevel` accepts `debug`, `info`, or `error` and defaults to `info`.

At `info`, the plugin records reservations (`compaction_scheduled`), completions (`compaction_completed`), failures (`compaction_failed`), notification failures (`session_message_failed`), and overlapping job runs (`compaction_window_jobs`, only when at least one exists). If reading job receipts fails, it records `compaction_window_jobs_failed`. At `debug`, it additionally records `agent_end` receipt and reservation matching, activity checks for other sessions, lock-file lists before and after connection release, every compaction attempt, session-notification sends, and overlap checks with no matching runs.

## OpenClaw configuration

Add this directory to `plugins.load.paths` and set `plugins.entries.deferred-compaction.enabled` to `true`. The plugin does not read conversation content, but because it uses the `agent_end` hook, `hooks.allowConversationAccess` must also be enabled.

Example:

```json
{
  "enabled": true,
  "hooks": {
    "allowConversationAccess": true
  },
  "config": {
    "delayMs": 1500,
    "idleWaitMs": 10000,
    "postTurnIdleWaitMs": 15000,
    "idlePollMs": 1000,
    "compactAttempts": 3,
    "logLevel": "info",
    "logFile": "logs/deferred-compaction.log",
    "maxLogLines": 500
  }
}
```

`codex` is a manifest dependency. The agent does not need the `Codex Plugins`, `Codex Threads`, or `message` tools enabled.

## License

UPL 1.0 (`UPL-1.0`). See [LICENSE](./LICENSE) for details.
