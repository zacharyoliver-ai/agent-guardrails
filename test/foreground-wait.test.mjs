import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check } from '../hooks/foreground-wait.mjs';

const script = fileURLToPath(new URL('../hooks/foreground-wait.mjs', import.meta.url));
const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command, ...extra } });
const denied = (command, env = {}) => check(bash(command), env) !== null;

test('full test runs are denied in the foreground', () => {
  for (const c of [
    'npm test', 'npm run test', 'pnpm test', 'yarn test', 'pytest', 'python -m pytest',
    'go test ./...', 'cargo test', 'node --test', 'node --test test/*.test.mjs',
    'node --test test/', 'npx playwright test', 'cd app && npm test',
    'node --test a.test.mjs b.test.mjs c.test.mjs d.test.mjs',
  ]) assert.ok(denied(c), c);
});

test('builds are denied in the foreground', () => {
  for (const c of ['npm run build', 'pnpm build', 'vite build', 'next build', 'cargo build', 'docker build .', 'tsc', 'tsc --noEmit', 'npx tsc -p .']) {
    assert.ok(denied(c), c);
  }
});

test('long sleeps and watchers are denied', () => {
  for (const c of ['sleep 30', 'sleep 2m', 'sleep 20 20', 'tail -f app.log', 'tail -F app.log', 'tail --follow x', 'vitest --watch', 'npm run dev --watch=true']) {
    assert.ok(denied(c), c);
  }
});

test('short runs pass', () => {
  for (const c of [
    'node --test test/a.test.mjs', 'node --test a.test.mjs b.test.mjs c.test.mjs',
    'node --test --test-name-pattern foo test/a.test.mjs', 'pytest tests/test_a.py',
    'pytest tests/test_a.py::test_one -k thing', 'npx playwright test e2e/a.spec.ts --project chromium',
    'npm test -- a.test.js', 'go test ./pkg', 'sleep 5', 'sleep 29', 'tail -n 20 app.log',
    'tsc --noEmit src/a.ts', 'tsc --version', 'ls -la', 'git status', 'echo "npm test"',
    'git commit -m "run npm test then npm run build"',
  ]) assert.equal(check(bash(c), {}), null, c);
});

test('run_in_background and other tools are allowed', () => {
  assert.equal(check(bash('npm test', { run_in_background: true }), {}), null);
  assert.equal(check({ tool_name: 'Read', tool_input: { command: 'npm test' } }, {}), null);
});

test('wrappers do not hide a long run', () => {
  assert.ok(denied('timeout 60 npm test'));
  assert.ok(denied('time npm run build'));
  assert.ok(denied('FOO=1 npm test'));
});

test('the reason says to use the background', () => {
  assert.match(check(bash('npm test'), {}), /run_in_background/);
});

test('GUARDRAILS_LONG_RUNS adds and allows by regex', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fw-')), 'runs.json');
  fs.writeFileSync(file, JSON.stringify({ add: ['^make all'], allow: ['^npm run build:fast'] }));
  const env = { GUARDRAILS_LONG_RUNS: file };
  assert.ok(denied('make all', env));
  assert.ok(!denied('make clean', env));
  assert.ok(!denied('npm run build:fast', env));
  assert.ok(denied('npm run build', env));
});

test('a missing or damaged config file falls back to the defaults', () => {
  assert.ok(denied('npm test', { GUARDRAILS_LONG_RUNS: path.join(os.tmpdir(), 'ag-no-such-file.json') }));
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('script: prints a deny decision for a long run', () => {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(bash('npm test')), encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
