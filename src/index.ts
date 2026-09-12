import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";

const TOOL_NAME = "compact_context_after_turn";
const CODEX_HARNESS_ID = "codex";
const CODEX_HOME_DIRNAME = "codex-home";
const THREAD_WRITER_LOCK_DIRNAME = "thread-writer-locks";
const AGENT_SQLITE_BASENAME = "openclaw-agent.sqlite";
const STATE_SQLITE_RELATIVE_PATH = ["state", "openclaw.sqlite"] as const;
/** A skipped receipt means the trigger condition did not hold, so no run competed with compaction. */
const NON_RUNNING_CRON_RECEIPT_STATUS = "skipped";
const CODEX_CLIENT_DISPOSER_SYMBOL = "openclaw.codexAppServerClientDisposer";
const SCHEDULED_TOOL_MESSAGE = "Session compaction is reserved. Tell the user to wait: this session will be unavailable for one to two minutes, until compaction finishes.";

/** Renders the compaction outcome so the session does not have to look the numbers up itself. */
function formatTokenChange(tokens: { before?: number; after?: number; contextWindow?: number }): string | undefined {
  const window = tokens.contextWindow === undefined ? "" : ` of ${tokens.contextWindow}`;
  if (tokens.before !== undefined && tokens.after !== undefined) {
    return `Context tokens: ${tokens.before} -> ${tokens.after}${window}.`;
  }
  if (tokens.after !== undefined) return `Context tokens after compaction: ${tokens.after}${window}.`;
  if (tokens.before !== undefined) return `Context tokens before compaction: ${tokens.before}${window}.`;
  return undefined;
}

/**
 * Renders the scheduled jobs that ran while compaction held the session, with the reason they
 * are worth reading. A bare list of runs invites the session to guess what it is being told, so
 * the purpose is stated. Nothing is said when no job ran, leaving a clean run to report the result only.
 */
function formatOverlappingJobs(jobs: OverlappingJobRun[]): string[] {
  if (jobs.length === 0) return [];
  const single = jobs.length === 1;
  return [
    `${single ? "1 scheduled job" : `${jobs.length} scheduled jobs`} ran while compaction was running:`,
    ...jobs.map((job) => `- job ${job.jobId}: ${job.status}${job.error ? ` (${job.error})` : ""}`),
    `Confirm that compaction caused no problem for ${single ? "it" : "them"} before resuming your work.`,
  ];
}

function buildCompletedSessionMessage(tokens: { before?: number; after?: number; contextWindow?: number }, jobs: OverlappingJobRun[]): string {
  return [
    "Session compaction finished.",
    formatTokenChange(tokens),
    ...formatOverlappingJobs(jobs),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildFailedSessionMessage(reason: string, jobs: OverlappingJobRun[]): string {
  return [
    `Session compaction failed. Reason: ${reason}`,
    "The context is left uncompacted.",
    ...formatOverlappingJobs(jobs),
    "Do not run compaction again.",
  ].join("\n");
}
const execFileAsync = promisify(execFile);

type PluginConfig = {
  delayMs: number;
  idleWaitMs: number;
  postTurnIdleWaitMs: number;
  idlePollMs: number;
  compactAttempts: number;
  logLevel: LogLevel;
  logFile: string;
  maxLogLines: number;
};

type LogLevel = "debug" | "info" | "error";

type TokenSnapshot = {
  totalTokens?: number;
  contextTokens?: number;
  totalTokensFresh?: boolean;
};

type PendingRequest = {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  requestedAt: string;
  beforeTokens?: number;
  beforeContextTokens?: number;
  beforeTokensFresh?: boolean;
};

type OverlappingJobRun = {
  jobId: string;
  status: string;
  error?: string;
};

type CodexSessionRow = {
  sessionKey: string;
  status: string;
  updatedAt: number;
};

type BusyCodexSession = {
  agentId: string;
  sessionKey: string;
  status: string;
  updatedAt: number;
  reason: "running" | "store_unreadable";
};

type ThreadWriterLock = {
  agentId: string;
  lockFile: string;
};

type RuntimeState = {
  id: string;
  createdAt: string;
  pending: Map<string, PendingRequest>;
  running: Set<string>;
};

type DeferredCompactionGlobal = typeof globalThis & {
  __sakilaboDeferredCompactionState?: RuntimeState;
  [key: symbol]: unknown;
};

function getRuntimeState(): RuntimeState {
  const shared = globalThis as DeferredCompactionGlobal;
  if (!shared.__sakilaboDeferredCompactionState) {
    shared.__sakilaboDeferredCompactionState = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      pending: new Map<string, PendingRequest>(),
      running: new Set<string>(),
    };
  }
  return shared.__sakilaboDeferredCompactionState;
}

const defaults: PluginConfig = {
  delayMs: 1500,
  idleWaitMs: 10_000,
  postTurnIdleWaitMs: 15_000,
  idlePollMs: 1000,
  compactAttempts: 3,
  logLevel: "info",
  logFile: "logs/deferred-compaction.log",
  maxLogLines: 500,
};

function positiveInteger(value: unknown, fallback: number, maximum?: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return fallback;
  return maximum === undefined ? value : Math.min(value, maximum);
}

function readConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = api.pluginConfig ?? {};
  return {
    delayMs: positiveInteger(raw.delayMs, defaults.delayMs),
    idleWaitMs: positiveInteger(raw.idleWaitMs, defaults.idleWaitMs),
    postTurnIdleWaitMs: positiveInteger(raw.postTurnIdleWaitMs, defaults.postTurnIdleWaitMs),
    idlePollMs: Math.max(100, positiveInteger(raw.idlePollMs, defaults.idlePollMs)),
    compactAttempts: Math.max(1, positiveInteger(raw.compactAttempts, defaults.compactAttempts)),
    logLevel: raw.logLevel === "info" || raw.logLevel === "error" || raw.logLevel === "debug" ? raw.logLevel : defaults.logLevel,
    logFile: typeof raw.logFile === "string" && raw.logFile.trim() ? raw.logFile.trim() : defaults.logFile,
    maxLogLines: Math.max(1, positiveInteger(raw.maxLogLines, defaults.maxLogLines, 500)),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveLogFile(api: OpenClawPluginApi, config: PluginConfig): string {
  if (isAbsolute(config.logFile)) return config.logFile;
  return resolve(api.rootDir ?? process.cwd(), config.logFile);
}

function shouldLog(configured: LogLevel, eventLevel: LogLevel): boolean {
  const priority: Record<LogLevel, number> = { debug: 10, info: 20, error: 30 };
  return priority[eventLevel] >= priority[configured];
}

async function logLine(api: OpenClawPluginApi, config: PluginConfig, event: Record<string, unknown>): Promise<void> {
  const eventLevel = event.level === "error" || event.level === "info" || event.level === "debug" ? event.level : "info";
  if (!shouldLog(config.logLevel, eventLevel)) return;
  const path = resolveLogFile(api, config);
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`, "utf8");

  const contents = await readFile(path, "utf8");
  const lines = contents.split(/\r?\n/u).filter(Boolean);
  if (lines.length > config.maxLogLines) {
    await writeFile(path, `${lines.slice(-config.maxLogLines).join("\n")}\n`, "utf8");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getTokenSnapshot(api: OpenClawPluginApi, agentId: string, sessionKey: string): TokenSnapshot {
  const entry = asRecord(api.runtime.agent.session.getSessionEntry({
    agentId,
    sessionKey,
    readConsistency: "latest",
  }));
  return {
    totalTokens: optionalNumber(entry?.totalTokens),
    contextTokens: optionalNumber(entry?.contextTokens),
    totalTokensFresh: typeof entry?.totalTokensFresh === "boolean" ? entry.totalTokensFresh : undefined,
  };
}

async function runOpenClawCli(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error("The OpenClaw CLI entry point is unavailable.");
  return await execFileAsync(process.execPath, [cliEntry, ...args], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
}

function currentConfig(api: OpenClawPluginApi): Parameters<typeof api.runtime.agent.resolveAgentDir>[0] {
  return api.runtime.config.current() as unknown as Parameters<typeof api.runtime.agent.resolveAgentDir>[0];
}

/** Lists every configured agent id, including the agent that reserved the compaction. */
function resolveAgentIds(api: OpenClawPluginApi, requestAgentId: string): string[] {
  const ids = new Set<string>([requestAgentId, ...listAgentIds(currentConfig(api))]);
  return [...ids].filter((id) => id.trim().length > 0);
}

function resolveAgentDir(api: OpenClawPluginApi, agentId: string): string {
  return api.runtime.agent.resolveAgentDir(currentConfig(api), agentId);
}

/**
 * Resolves the SQLite session store of one agent. `runtime.agent.session.resolveStorePath`
 * still answers with the legacy `sessions\sessions.json` location, so the agent directory
 * and the basename OpenClaw itself uses are combined instead.
 */
function resolveSessionStorePath(api: OpenClawPluginApi, agentId: string): string {
  return join(resolveAgentDir(api, agentId), AGENT_SQLITE_BASENAME);
}

function resolveThreadWriterLockDir(api: OpenClawPluginApi, agentId: string): string {
  return join(resolveAgentDir(api, agentId), CODEX_HOME_DIRNAME, THREAD_WRITER_LOCK_DIRNAME);
}

function isMissingPathError(error: unknown): boolean {
  const code = asRecord(error)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Reads the scheduled jobs of one agent whose run overlapped the compaction window.
 * Compaction releases the Codex app-server connection and holds the session, so a job firing at
 * the same time can be disrupted. The receipt records the job's own outcome and carries no trace
 * of the compaction, so a disrupted run can still settle as `ok`; filtering by status would hide
 * exactly the cases worth reading. Every run is reported instead, and the session judges it.
 */
function readOverlappingJobRuns(agentId: string, windowStartMs: number, windowEndMs: number): OverlappingJobRun[] {
  const storePath = join(resolveStateDir(), ...STATE_SQLITE_RELATIVE_PATH);
  if (!existsSync(storePath)) return [];
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const rows = db.prepare(
      "select job_id as jobId, status, error_text as errorText from cron_run_receipts"
      + " where agent_id = ? and status <> ?"
      + " and started_at_ms <= ? and coalesce(finished_at_ms, ?) >= ?"
      + " order by started_at_ms",
    ).all(agentId, NON_RUNNING_CRON_RECEIPT_STATUS, windowEndMs, windowEndMs, windowStartMs) as unknown as {
      jobId?: unknown;
      status?: unknown;
      errorText?: unknown;
    }[];
    return rows.map((row) => {
      const error = typeof row.errorText === "string" ? row.errorText.trim() : "";
      return {
        jobId: String(row.jobId ?? ""),
        status: String(row.status ?? ""),
        ...error ? { error } : {},
      };
    });
  } finally {
    db.close();
  }
}

/** Reads the Codex-backed session rows of one agent store without taking a write lock. */
function readCodexSessionRows(storePath: string): CodexSessionRow[] {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const rows = db.prepare(
      "select session_key as sessionKey, coalesce(status, '') as status, coalesce(updated_at, 0) as updatedAt"
      + " from session_windows where agent_harness_id = ?",
    ).all(CODEX_HARNESS_ID) as unknown as CodexSessionRow[];
    return rows.map((row) => ({
      sessionKey: String(row.sessionKey ?? ""),
      status: String(row.status ?? ""),
      updatedAt: Number(row.updatedAt ?? 0),
    }));
  } finally {
    db.close();
  }
}

/** Collects Codex sessions that must not be interrupted by an app-server client release. */
function collectBusyCodexSessions(api: OpenClawPluginApi, request: PendingRequest): BusyCodexSession[] {
  const busy: BusyCodexSession[] = [];
  for (const agentId of resolveAgentIds(api, request.agentId)) {
    const storePath = resolveSessionStorePath(api, agentId);
    if (!existsSync(storePath)) continue;
    let rows: CodexSessionRow[];
    try {
      rows = readCodexSessionRows(storePath);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      busy.push({ agentId, sessionKey: storePath, status: errorText(error), updatedAt: 0, reason: "store_unreadable" });
      continue;
    }
    for (const row of rows) {
      if (row.sessionKey === request.sessionKey) continue;
      if (row.status !== "running") continue;
      busy.push({ agentId, sessionKey: row.sessionKey, status: row.status, updatedAt: row.updatedAt, reason: "running" });
    }
  }
  return busy;
}

/**
 * Waits until no other Codex session is running. The tool call uses the short in-turn budget;
 * the post-turn run only absorbs a session that started while the turn was finishing.
 */
async function waitForIdleCodexSessions(
  api: OpenClawPluginApi,
  config: PluginConfig,
  request: PendingRequest,
  phase: "tool" | "post_turn" | "retry",
  waitMs: number,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const busy = collectBusyCodexSessions(api, request);
    if (busy.length === 0) {
      await logLine(api, config, {
        level: "debug",
        event: "codex_sessions_idle",
        phase,
        agentId: request.agentId,
        sessionKey: request.sessionKey,
      });
      return;
    }
    await logLine(api, config, {
      level: "debug",
      event: "codex_sessions_busy",
      phase,
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      busy,
      remainingMs: Math.max(0, deadline - Date.now()),
    });
    if (Date.now() >= deadline) {
      const detail = busy.map((item) => `${item.agentId}:${item.sessionKey || "?"}(${item.reason})`).join(", ");
      throw new Error(`Other Codex sessions were still active after ${waitMs}ms: ${detail}`);
    }
    await sleep(config.idlePollMs);
  }
}

async function listThreadWriterLocks(api: OpenClawPluginApi, agentIds: string[]): Promise<ThreadWriterLock[]> {
  const locks: ThreadWriterLock[] = [];
  for (const agentId of agentIds) {
    let names: string[];
    try {
      names = await readdir(resolveThreadWriterLockDir(api, agentId));
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".lock") || name.startsWith(".")) continue;
      locks.push({ agentId, lockFile: name });
    }
  }
  return locks;
}

/** Resolves the disposer the Codex plugin publishes on globalThis for its shared app-server clients. */
function findCodexAppServerClientDisposer(): (() => Promise<void>) | undefined {
  for (const symbol of Object.getOwnPropertySymbols(globalThis)) {
    const description = symbol.description;
    if (!description) continue;
    if (description !== CODEX_CLIENT_DISPOSER_SYMBOL && !description.startsWith(`${CODEX_CLIENT_DISPOSER_SYMBOL}@`)) continue;
    const value = (globalThis as DeferredCompactionGlobal)[symbol];
    if (typeof value === "function") return value as () => Promise<void>;
  }
  return undefined;
}

/** Closes the shared Codex app-server clients so the thread-store writer lock is released. */
async function releaseCodexAppServerClients(api: OpenClawPluginApi, config: PluginConfig, request: PendingRequest): Promise<void> {
  const agentIds = resolveAgentIds(api, request.agentId);
  const before = await listThreadWriterLocks(api, agentIds);
  await logLine(api, config, {
    level: "debug",
    event: "codex_client_release_started",
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    locksBefore: before,
  });

  const dispose = findCodexAppServerClientDisposer();
  if (!dispose) throw new Error("The Codex app-server client disposer is unavailable.");
  await dispose();

  // The disposer waits for the app-server processes to exit, so the release is already complete here.
  // Lock files survive a forced kill, so they are recorded as context instead of being waited on.
  const remaining = await listThreadWriterLocks(api, agentIds);
  await logLine(api, config, {
    level: "debug",
    event: "codex_client_release_completed",
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    locksRemaining: remaining,
  });
}

type CompactionAttempt = {
  result?: Record<string, unknown>;
  failure?: string;
};

async function runCompactCommand(
  api: OpenClawPluginApi,
  config: PluginConfig,
  request: PendingRequest,
  attempt: number,
): Promise<CompactionAttempt> {
  let stdout = "";
  let stderr = "";
  let failure: string | undefined;
  try {
    const result = await runOpenClawCli([
      "sessions", "compact", request.sessionKey,
      "--agent", request.agentId,
      "--json",
      "--timeout", "120000",
    ], 130_000);
    stdout = result.stdout.trim();
    stderr = result.stderr.trim();
  } catch (error) {
    const record = asRecord(error);
    stdout = String(record?.stdout ?? "").trim();
    stderr = String(record?.stderr ?? "").trim();
    failure = errorText(error);
  }
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(JSON.parse(stdout) as unknown);
  } catch {
    // The unparsable output is reported through the attempt log below.
  }
  await logLine(api, config, {
    level: "debug",
    event: "sessions_compact_attempt",
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    attempt,
    ok: parsed?.ok === true,
    result: parsed,
    stdout: parsed ? undefined : stdout || undefined,
    stderr: stderr || undefined,
    error: failure,
  });
  if (parsed?.ok === true) return { result: parsed };
  return { failure: [stdout, stderr, failure].filter(Boolean).join(" ") || "unknown error" };
}

/**
 * Wakes the session that reserved the compaction. The in-process
 * `dispatchGatewayMethod` is reserved for authenticated plugin HTTP routes, so the
 * OpenClaw CLI dispatches the send for this background task instead.
 *
 * `chat.send` with `deliver: true` is used instead of `sessions.send` because
 * `sessions.send` cannot carry a delivery flag: it forwards a fixed parameter set to
 * `chat.send`, and without `deliver` the reply is routed to the internal message
 * channel, so the resulting turn reaches Control UI subscribers only. With `deliver`
 * the route is resolved from the session's own stored delivery context, which keeps
 * this channel-agnostic; sessions without an external route still commit to the
 * transcript as before.
 */
async function sendSessionMessage(api: OpenClawPluginApi, config: PluginConfig, request: PendingRequest, message: string, outcome: "completed" | "failed"): Promise<void> {
  await logLine(api, config, {
    level: "debug",
    event: "session_message_started",
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    outcome,
  });
  const { stdout } = await runOpenClawCli([
    "gateway", "call", "chat.send",
    "--params", JSON.stringify({
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      message,
      deliver: true,
      idempotencyKey: randomUUID(),
    }),
    "--json",
    "--timeout", "30000",
  ], 40_000);
  await logLine(api, config, {
    level: "debug",
    event: "session_message_completed",
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    outcome,
    response: stdout.trim().slice(0, 500) || undefined,
  });
}

/** Never lets a missing or changed state store keep the session from being told the compaction ended. */
async function collectOverlappingJobRuns(api: OpenClawPluginApi, config: PluginConfig, request: PendingRequest, windowStartMs: number): Promise<OverlappingJobRun[]> {
  const windowEndMs = Date.now();
  try {
    const jobs = readOverlappingJobRuns(request.agentId, windowStartMs, windowEndMs);
    await logLine(api, config, {
      level: jobs.length > 0 ? "info" : "debug",
      event: "compaction_window_jobs",
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      windowStartMs,
      windowEndMs,
      jobs,
    });
    return jobs;
  } catch (error) {
    await logLine(api, config, {
      level: "error",
      event: "compaction_window_jobs_failed",
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      windowStartMs,
      windowEndMs,
      error: errorText(error),
    });
    return [];
  }
}

async function runCompaction(api: OpenClawPluginApi, config: PluginConfig, request: PendingRequest): Promise<void> {
  const windowStartMs = Date.now();
  await logLine(api, config, {
    level: "debug",
    event: "deferred_execution_started",
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    sessionId: request.sessionId,
    delayMs: config.delayMs,
  });
  await sleep(config.delayMs);
  try {
    await logLine(api, config, {
      level: "debug",
      event: "token_snapshot_before_release",
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      sessionId: request.sessionId,
      totalTokens: request.beforeTokens,
      contextTokens: request.beforeContextTokens,
      totalTokensFresh: request.beforeTokensFresh,
    });
    let compactResult: Record<string, unknown> | undefined;
    let lastFailure = "unknown error";
    for (let attempt = 1; attempt <= config.compactAttempts && !compactResult; attempt += 1) {
      if (attempt > 1) await sleep(config.idlePollMs);
      await waitForIdleCodexSessions(
        api,
        config,
        request,
        attempt === 1 ? "post_turn" : "retry",
        attempt === 1 ? config.postTurnIdleWaitMs : 0,
      );
      await releaseCodexAppServerClients(api, config, request);
      const outcome = await runCompactCommand(api, config, request, attempt);
      compactResult = outcome.result;
      if (!compactResult) lastFailure = outcome.failure ?? lastFailure;
    }
    if (!compactResult) {
      throw new Error(`Session compaction failed after ${config.compactAttempts} attempt(s): ${lastFailure}`);
    }
    const tokensBefore = optionalNumber(compactResult.tokensBefore) ?? request.beforeTokens;
    const after = getTokenSnapshot(api, request.agentId, request.sessionKey);
    const tokensAfter = optionalNumber(compactResult.tokensAfter) ?? after.totalTokens;
    await logLine(api, config, {
      level: "info",
      event: "compaction_completed",
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      sessionId: request.sessionId,
      requestedAt: request.requestedAt,
      compacted: compactResult.compacted === true,
      reason: compactResult.reason,
      beforeTokens: tokensBefore,
      beforeContextTokens: request.beforeContextTokens,
      beforeTokensFresh: request.beforeTokensFresh,
      afterTokens: tokensAfter,
      afterContextTokens: after.contextTokens,
      afterTokensFresh: after.totalTokensFresh,
      result: compactResult,
    });
    try {
      await sendSessionMessage(api, config, request, buildCompletedSessionMessage({
        before: tokensBefore,
        after: tokensAfter,
        contextWindow: after.contextTokens ?? request.beforeContextTokens,
      }, await collectOverlappingJobRuns(api, config, request, windowStartMs)), "completed");
    } catch (sendError) {
      api.logger.error(`Failed to notify ${request.sessionKey} about the finished compaction: ${errorText(sendError)}`);
      await logLine(api, config, {
        level: "error",
        event: "session_message_failed",
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        outcome: "completed",
        error: errorText(sendError),
      });
    }
  } catch (error) {
    const message = errorText(error);
    api.logger.error(`Deferred compaction failed for ${request.sessionKey}: ${message}`);
    try {
      await logLine(api, config, {
        level: "error",
        event: "compaction_failed",
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        sessionId: request.sessionId,
        requestedAt: request.requestedAt,
        beforeTokens: request.beforeTokens,
        beforeContextTokens: request.beforeContextTokens,
        error: message,
      });
    } catch (logError) {
      api.logger.error(`Failed to write deferred compaction log: ${errorText(logError)}`);
    }
    try {
      await sendSessionMessage(api, config, request, buildFailedSessionMessage(message, await collectOverlappingJobRuns(api, config, request, windowStartMs)), "failed");
    } catch (sendError) {
      api.logger.error(`Failed to notify ${request.sessionKey} about the failed compaction: ${errorText(sendError)}`);
      await logLine(api, config, {
        level: "error",
        event: "session_message_failed",
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        outcome: "failed",
        error: errorText(sendError),
      });
    }
  }
}

function requestFromContext(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext): PendingRequest | undefined {
  if (!ctx.agentId || !ctx.sessionKey) return undefined;
  const before = getTokenSnapshot(api, ctx.agentId, ctx.sessionKey);
  return {
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    requestedAt: new Date().toISOString(),
    beforeTokens: before.totalTokens,
    beforeContextTokens: before.contextTokens,
    beforeTokensFresh: before.totalTokensFresh,
  };
}

export default definePluginEntry({
  id: "deferred-compaction",
  name: "Deferred Compaction",
  description: "Schedules Codex-backed session compaction after the current agent turn ends.",
  register(api) {
    const config = readConfig(api);
    const runtimeState = getRuntimeState();
    const { pending, running } = runtimeState;

    void logLine(api, config, {
      level: "debug",
      event: "plugin_instance_registered",
      runtimeStateId: runtimeState.id,
      runtimeStateCreatedAt: runtimeState.createdAt,
      pendingCount: pending.size,
      runningCount: running.size,
    });

    api.registerTool((ctx) => ({
      name: TOOL_NAME,
      label: "Compact Context After Turn",
      description: "Reserve compaction of the current Codex-backed OpenClaw session. The plugin runs it only after this agent turn has ended, then sends a message back to this session when it finished or failed. Call at most once per turn, end the turn right after calling it, and wait for that message.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const request = requestFromContext(api, ctx);
        if (!request) {
          await logLine(api, config, {
            level: "error",
            event: "compaction_schedule_rejected",
            reason: "missing_agent_or_session_context",
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            messageChannel: ctx.messageChannel,
          });
          throw new Error("The current agentId or sessionKey is unavailable; compaction was not scheduled.");
        }
        try {
          await waitForIdleCodexSessions(api, config, request, "tool", config.idleWaitMs);
        } catch (error) {
          const message = errorText(error);
          await logLine(api, config, {
            level: "error",
            event: "compaction_schedule_rejected",
            reason: "codex_sessions_active",
            agentId: request.agentId,
            sessionKey: request.sessionKey,
            sessionId: request.sessionId,
            error: message,
          });
          throw new Error(`Compaction was not scheduled. ${message}`);
        }
        const replacedExistingRequest = pending.has(request.sessionKey);
        pending.set(request.sessionKey, request);
        await logLine(api, config, {
          level: "info",
          event: "compaction_scheduled",
          agentId: request.agentId,
          sessionKey: request.sessionKey,
          sessionId: request.sessionId,
          replacedExistingRequest,
          pendingCount: pending.size,
          runtimeStateId: runtimeState.id,
        });
        return {
          content: [{ type: "text", text: SCHEDULED_TOOL_MESSAGE }],
          details: { scheduled: true, sessionKey: request.sessionKey },
        };
      },
    }), { name: TOOL_NAME });

    api.on("agent_end", (_event, ctx) => {
      void logLine(api, config, {
        level: "debug",
        event: "agent_end_received",
        runId: ctx.runId,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        pendingCount: pending.size,
        pendingSessionKeys: [...pending.keys()],
        runtimeStateId: runtimeState.id,
      });
      if (!ctx.sessionKey) {
        void logLine(api, config, {
          level: "debug",
          event: "agent_end_ignored",
          reason: "missing_session_key",
          runId: ctx.runId,
          agentId: ctx.agentId,
          pendingCount: pending.size,
        });
        return;
      }
      const sessionKey = ctx.sessionKey;
      const request = pending.get(sessionKey);
      if (!request) {
        void logLine(api, config, {
          level: "debug",
          event: "agent_end_ignored",
          reason: "no_matching_pending_request",
          runId: ctx.runId,
          agentId: ctx.agentId,
          sessionKey,
          pendingCount: pending.size,
          pendingSessionKeys: [...pending.keys()],
        });
        return;
      }
      if (running.has(sessionKey)) {
        void logLine(api, config, {
          level: "debug",
          event: "agent_end_ignored",
          reason: "compaction_already_running",
          runId: ctx.runId,
          agentId: ctx.agentId,
          sessionKey,
        });
        return;
      }
      pending.delete(sessionKey);
      running.add(sessionKey);
      void logLine(api, config, {
        level: "debug",
        event: "pending_request_matched",
        runId: ctx.runId,
        agentId: ctx.agentId,
        sessionKey,
        pendingCount: pending.size,
      });
      void runCompaction(api, config, request).finally(() => {
        running.delete(sessionKey);
        void logLine(api, config, {
          level: "debug",
          event: "deferred_execution_finished",
          agentId: request.agentId,
          sessionKey,
          runningCount: running.size,
        });
      });
    });
  },
});
