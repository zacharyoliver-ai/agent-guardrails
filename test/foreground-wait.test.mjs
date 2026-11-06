import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check } from '../hooks/foreground-wait.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const script = fileURLToPath(new URL('../hooks/foreground-wait.mjs', import.meta.url));
const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command, ...extra } });
const denied = (command, env = {}) => check(bash(command), env) !== null;

test('an input redirection is not a file', () => {
  for (const c of ['node --test a.test.mjs </dev/null', 'node --test a.test.mjs < /dev/null', 'node --test $F </dev/null']) {
    assert.equal(denied(c), false, c);
  }
  assert.equal(denied('node --test </dev/null'), true);
  assert.equal(denied('node --test test/*.test.mjs </dev/null'), true);
});

test('--test after the script is the script\'s own option', () => {
  for (const c of ['node bin/planted-fault.mjs --file a.mjs --find x --replace y --test "npm test"', 'node tool.mjs --test', 'node --trace-warnings tool.mjs --test']) {
    assert.equal(denied(c), false, c);
  }
  for (const c of ['node --test', 'node --trace-warnings --test', 'node --import ./setup.mjs --test', 'node --test-reporter tap --test', 'node -r ./setup.js --test']) {
    assert.equal(denied(c), true, c);
  }
  assert.equal(denied('node --import ./setup.mjs --test a.test.mjs'), false);
});

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

test('Playwright, Jest and Vitest filters: one to three name filters are a short run', () => {
  for (const c of [
    'npx playwright test checkout', 'npx playwright test -c a.config.js login-flow --reporter=line', 'npx playwright test e2e/a.spec.ts:12',
    'npx jest src/a.test.js', 'npx jest login', 'npx vitest run src/a.test.ts', 'vitest run login', 'jest --version', 'vitest --help',
  ]) assert.equal(check(bash(c), {}), null, c);
  for (const c of [
    'npx playwright test', 'npx playwright test tests/', 'npx playwright test tests', 'npx playwright test e2e/*', 'npx playwright test a b c d',
    'npx jest', 'jest', 'npx vitest run', 'vitest run', 'vitest', 'vitest --watch',
  ]) assert.ok(denied(c), c);
});

test('a line suffix still names a file', () => {
  for (const c of ['node --test a.spec.ts:12', 'node --test a.test.mjs:3:5', 'pytest a.py::test_one']) assert.equal(check(bash(c), {}), null, c);
});

test('a shell variable counts as one file', () => {
  for (const c of ['node --test $f', 'node --test ${f}', 'node --test --test-reporter=tap $SPECS', 'node --test "$D/a.test.mjs"', 'node --test ${D}/a.test.mjs', 'timeout 60 node --test $f 2>&1 | grep x']) {
    assert.equal(check(bash(c), {}), null, c);
  }
  for (const c of ['node --test $D/*.test.mjs', 'node --test "$D/"', 'node --test $a $b $c $d']) assert.ok(denied(c), c);
});

test('a redirection does not count as a file to test', () => {
  const run = (command) => check({ tool_name: 'Bash', tool_input: { command } }, {});
  for (const c of [
    'node --test test/a.test.mjs 2>&1 | tail -n 5', 'node --test test/a.test.mjs > out.txt', 'node --test test/a.test.mjs 2>/dev/null',
    'node --test a.test.mjs b.test.mjs c.test.mjs >> log.txt 2>&1', 'npm test -- test/a.test.js 2>&1 | tail', 'git status 2>&1 | head && node --test test/a.test.mjs 2>&1 | tail',
  ]) assert.equal(run(c), null, c);
  for (const c of ['node --test 2>&1 | tail', 'node --test a.test.mjs b.test.mjs c.test.mjs d.test.mjs > out.txt 2>&1', 'npm test 2>&1 | tail']) {
    assert.notEqual(run(c), null, c);
  }
});

test('a watch flag that turns watching off is allowed', () => {
  for (const c of ['vitest run login --watch=false', 'vitest run login --watch=0']) assert.ok(!denied(c), c);
  for (const c of ['vitest --watch', 'vitest --watch=true', 'vitest --watch=1']) assert.ok(denied(c), c);
});

test('the PowerShell tool is checked like Bash', () => {
  const ps = (command, extra = {}) => check({ tool_name: 'PowerShell', tool_input: { command, ...extra } }, {});
  assert.match(ps('npm test'), /run_in_background/);
  assert.equal(ps('npm test', { run_in_background: true }), null);
  assert.equal(ps('node --test a.test.mjs'), null);
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
  const file = path.join(tmpDir('ag-fw-'), 'runs.json');
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
