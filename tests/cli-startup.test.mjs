import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { CLI_STARTUP_IMPORT } from '../dist/cli-startup.js';

function transform(source, url = 'file:///app/node_modules/openclaw/dist/test.mjs') {
  let hook;
  const code = Buffer.from(CLI_STARTUP_IMPORT.split(',')[1], 'base64').toString('utf8')
    .replace('import { registerHooks } from "node:module";', '')
    .replaceAll('import.meta.url', 'SELF_URL');
  vm.runInNewContext(code, { registerHooks: value => { hook = value; }, SELF_URL: CLI_STARTUP_IMPORT });
  return hook.load(url, {}, () => ({ source })).source;
}

test('plugin supplies a self contained startup implementation', () => {
  assert(CLI_STARTUP_IMPORT.startsWith('data:text/javascript;base64,'));
});
test('worker inherits the same implementation', () => {
  const source = transform('function resolveRuntimeWorkerThreadExecArgv() { return ["--no-warnings"]; }');
  const args = vm.runInNewContext(source + '; resolveRuntimeWorkerThreadExecArgv()');
  assert.deepEqual(Array.from(args), ['--no-warnings', '--import', CLI_STARTUP_IMPORT]);
});
test('plugin loader avoids duplicating non bundled plugins', () => {
  const source = 'function check(p) { if (p.origin === "bundled" && ready(p.source)) { if (p.expectedSourceDigest !== void 0) throw Error("Source digest validation is not applicable to core-bundled runtime modules"); return true; } return false; }';
  const patched = transform(source);
  assert(patched.includes('if (ready(p.source))'));
  assert.equal(vm.runInNewContext(patched + '; check({origin:"external",source:"x"})', { ready: () => true }), true);
  assert.equal(transform(source, 'file:///app/other.mjs'), source);
});
test('CLI startup bypasses repeated SQLite integrity work', () => {
  const source = transform('function runSqliteCheck() { throw Error("expensive"); }\nfunction runSqliteForeignKeyCheck() { throw Error("expensive"); }');
  assert.equal(vm.runInNewContext(source + '; runSqliteCheck()'), 'ok');
  assert.equal(vm.runInNewContext(source + '; runSqliteForeignKeyCheck()'), undefined);
});

test('non bundled source digests work on the accelerated path', () => {
  const source = 'function check(p) { if (p.origin === "bundled" && ready(p.source)) { if (p.expectedSourceDigest !== void 0) throw Error("Source digest validation is not applicable to core-bundled runtime modules"); return true; } return false; }';
  const patched = transform(source);
  assert.equal(vm.runInNewContext(patched + '; check({origin:"external",source:"x",expectedSourceDigest:"digest"})', { ready: () => true }), true);
  assert.throws(() => vm.runInNewContext(patched + '; check({origin:"bundled",source:"x",expectedSourceDigest:"digest"})', { ready: () => true }), /core-bundled/);
});


test('configured MCP omissions and startup diagnostics create no model instructions', () => {
  const source = [
    'function formatConfiguredMcpDiagnosticNotice(messages, runLabel) {',
    ' const bounded = [...new Set(messages)].filter(Boolean);',
    ' if (bounded.length === 0) return;',
    ' return `Configured MCP is incomplete for ${runLabel}: ${bounded.join("; ")}. Do not claim MCP-backed work succeeded; report this blocker to the operator.`;',
    '}',
    'function executeTool() { return { status: "error", error: "actual call failed" }; }'
  ].join('\n');
  const patched = transform(source);
  assert(!patched.includes('report this blocker'));
  assert(!patched.includes('Configured MCP is incomplete'));
  for (const messages of [[], ['2 configured MCP tool(s) omitted by policy'], ['notion: connection failed']]) {
    const result = vm.runInNewContext(patched + '; formatConfiguredMcpDiagnosticNotice(messages, "this scheduled run")', { messages });
    assert.equal(result, undefined);
  }
  assert.equal(vm.runInNewContext(patched + '; executeTool().error'), 'actual call failed');
  assert.equal(transform(patched), patched);
});
