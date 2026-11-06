import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkContracts, statusOf } from '../bin/contract-check.mjs';

const script = fileURLToPath(new URL('../bin/contract-check.mjs', import.meta.url));

// A tiny module, a test that covers one of its behaviors, and a contract naming both.
function project(contract) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-contract-'));
  fs.mkdirSync(path.join(dir, 'contracts'));
  fs.writeFileSync(path.join(dir, 'mod.mjs'), 'export const add = (a, b) => a + b;\nexport const neg = (a) => -a;\n');
  fs.writeFileSync(path.join(dir, 'other.mjs'), 'export const one = 1;\n');
  fs.writeFileSync(
    path.join(dir, 'mod.test.mjs'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from './mod.mjs';",
      "test('add', () => assert.equal(add(2, 3), 5));",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'contracts', 'math.json'), JSON.stringify(contract));
  return dir;
}

const good = { file: 'mod.mjs', find: 'a + b', replace: 'a - b' };
const cmd = 'node --test mod.test.mjs';
const contract = (always, never = []) => ({ feature: 'math', purpose: 'adds', always, never });
const statuses = (dir, extra = {}) => checkContracts({ root: dir, ...extra }).map((r) => r.status);

test('statusOf maps each exit code', () => {
  assert.equal(statusOf(0), 'PROVEN');
  assert.equal(statusOf(1), 'MISSED');
  assert.equal(statusOf(2), 'UNPROVEN');
  assert.equal(statusOf(3), 'UNPROVEN');
});

test('a line whose test fails on the fault is PROVEN', () => {
  const dir = project(contract([{ rule: 'adds', test: cmd, fault: good }]));
  assert.deepEqual(statuses(dir), ['PROVEN']);
});

test('a line whose test still passes with the fault is MISSED', () => {
  const dir = project(contract([{ rule: 'negates', test: cmd, fault: { file: 'mod.mjs', find: '-a', replace: 'a' } }]));
  assert.deepEqual(statuses(dir), ['MISSED']);
});

test('a missing test, a missing fault and a test that fails first are UNPROVEN', () => {
  const dir = project(
    contract([
      { rule: 'no test', fault: good },
      { rule: 'no fault', test: cmd },
      { rule: 'broken first', test: 'node -e "process.exit(1)"', fault: good },
      { rule: 'find missing', test: cmd, fault: { file: 'mod.mjs', find: 'zzz', replace: 'y' } },
      { rule: 'file missing', test: cmd, fault: { file: 'nope.mjs', find: 'a', replace: 'b' } },
    ]),
  );
  assert.deepEqual(statuses(dir), ['UNPROVEN', 'UNPROVEN', 'UNPROVEN', 'UNPROVEN', 'UNPROVEN']);
});

test('always and never lines are both checked and labelled', () => {
  const dir = project(contract([{ rule: 'a', test: cmd, fault: good }], [{ rule: 'n', test: cmd, fault: good }]));
  assert.deepEqual(checkContracts({ root: dir }).map((r) => r.kind), ['always', 'never']);
});

test('the file under test is restored after proving', () => {
  const dir = project(contract([{ rule: 'adds', test: cmd, fault: good }]));
  const before = fs.readFileSync(path.join(dir, 'mod.mjs'), 'utf8');
  checkContracts({ root: dir });
  assert.equal(fs.readFileSync(path.join(dir, 'mod.mjs'), 'utf8'), before);
});

test('--changed re-proves only contracts whose fault files changed', () => {
  const dir = project(contract([{ rule: 'adds', test: cmd, fault: good }]));
  assert.equal(checkContracts({ root: dir, changed: ['other.mjs'] }).length, 0);
  assert.equal(checkContracts({ root: dir, changed: ['./mod.mjs'] }).length, 1);
  assert.equal(checkContracts({ root: dir, changed: [path.join(dir, 'mod.mjs')] }).length, 1);
});

test('cli: exit 0 when all proven, 1 on a missed line, --json prints rows', () => {
  const ok = project(contract([{ rule: 'adds', test: cmd, fault: good }]));
  const r = spawnSync(process.execPath, [script, '--json'], { cwd: ok, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout)[0].status, 'PROVEN');

  const bad = project(contract([{ rule: 'negates', test: cmd, fault: { file: 'mod.mjs', find: '-a', replace: 'a' } }]));
  const b = spawnSync(process.execPath, [script], { cwd: bad, encoding: 'utf8' });
  assert.equal(b.status, 1);
  assert.match(b.stdout, /MISSED/);
});

test('cli: --changed with files and a folder argument', () => {
  const dir = project(contract([{ rule: 'adds', test: cmd, fault: good }]));
  const r = spawnSync(process.execPath, [script, 'contracts', '--changed', 'other.mjs', 'x.mjs', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('cli: a missing folder, bad JSON and an unknown option exit 2', () => {
  const dir = project(contract([]));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run('nowhere').status, 2);
  assert.equal(run('--bogus').status, 2);
  fs.writeFileSync(path.join(dir, 'contracts', 'bad.json'), '{nope');
  assert.equal(run().status, 2);
});

test('a line whose fault makes the test hang is UNPROVEN with a TIMEOUT detail', () => {
  const dir = project(contract([{ rule: 'waits', test: 'node --test wait.test.mjs', fault: { file: 'wait.mjs', find: 'r, 0)', replace: 'r, 6000)' } }]));
  fs.writeFileSync(path.join(dir, 'wait.mjs'), 'export const wait = () => new Promise((r) => setTimeout(r, 0));\n');
  fs.writeFileSync(path.join(dir, 'wait.test.mjs'), "import test from 'node:test';\nimport { wait } from './wait.mjs';\ntest('waits', async () => { await wait(); });\n");
  const [r] = checkContracts({ root: dir, timeout: 3 });
  assert.equal(r.status, 'UNPROVEN');
  assert.match(r.detail, /^TIMEOUT/);
});
