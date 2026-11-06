import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runMatrix, renderProof } from '../bin/proof-matrix.mjs';

const script = fileURLToPath(new URL('../bin/proof-matrix.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// A tiny project: one module, one test that checks it, and a fault the test catches and one it cannot.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pm-'));
  for (const d of ['lib', 'test', 'proof/faults']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib/add.mjs'), 'export const add = (a, b) => a + b;\nexport const unused = () => 1;\n');
  fs.writeFileSync(
    path.join(dir, 'test/add.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../lib/add.mjs';\ntest('adds', () => { assert.equal(add(1, 2), 3); });\n",
  );
  const t = 'node --test test/add.test.mjs';
  fs.writeFileSync(
    path.join(dir, 'proof/faults/add.json'),
    JSON.stringify({
      name: 'add',
      kind: 'guard',
      what: 'Adds numbers.',
      faults: [
        { fault: 'Add subtracts.', file: 'lib/add.mjs', find: 'a + b', replace: 'a - b', test: t },
        { fault: 'The unused helper changes.', file: 'lib/add.mjs', find: '=> 1;', replace: '=> 2;', test: t },
        { fault: 'Add multiplies.', file: 'lib/add.mjs', find: 'a + b', replace: 'a * b', test: t },
      ],
    }),
  );
  return dir;
}

test('runs every fault, marks the caught ones and reports a weak test as MISSED', () => {
  const dir = fixture();
  const { results, total, caught } = runMatrix({ root: dir });
  assert.equal(total, 3);
  assert.deepEqual(results.map((r) => r.status), ['CAUGHT', 'MISSED', 'CAUGHT']);
  assert.equal(caught, 2);
  assert.match(results[1].detail, /MISSED/);
});

test('the working tree is never changed, and the temp copy is removed', () => {
  const dir = fixture();
  const before = fs.readFileSync(path.join(dir, 'lib/add.mjs'), 'utf8');
  // A private temp folder, so a matrix running in another process can't change the count.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pm-tmp-'));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  try {
    runMatrix({ root: dir });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(fs.readFileSync(path.join(dir, 'lib/add.mjs'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('ag-matrix-')), []);
});

test('--only limits the run, and an unknown name is an error', () => {
  const dir = fixture();
  assert.equal(runMatrix({ root: dir, only: ['add'] }).total, 3);
  assert.throws(() => runMatrix({ root: dir, only: ['nope'] }), /no fault file named nope/);
});

test('a fault whose file or find text is wrong is an ERROR, not CAUGHT', () => {
  const dir = fixture();
  const p = path.join(dir, 'proof/faults/add.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.faults = [
    { ...j.faults[0], file: 'lib/missing.mjs' },
    { ...j.faults[0], find: 'no such text' },
  ];
  fs.writeFileSync(p, JSON.stringify(j));
  assert.deepEqual(runMatrix({ root: dir }).results.map((r) => r.status), ['ERROR', 'ERROR']);
});

test('a damaged fault file is an ERROR row', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'proof/faults/bad.json'), '{nope');
  const { results } = runMatrix({ root: dir });
  assert.ok(results.some((r) => r.tool === 'bad' && r.status === 'ERROR'));
});

test('PROOF.md has a table per kind, the totals and no dates', () => {
  const dir = fixture();
  const text = renderProof(runMatrix({ root: dir }));
  assert.match(text, /^# Proof/);
  assert.match(text, /2 of 3 planted faults are caught, across 1 tools\./);
  assert.match(text, /## Guards\n\n\| Tool \| What it guarantees \| Bug we planted \| Result \|/);
  assert.match(text, /\| `add` \| Adds numbers\. \| Add subtracts\. \| CAUGHT \|/);
  assert.match(text, /\| MISSED \|/);
  assert.doesNotMatch(text, /## Stop hooks/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/);
  assert.match(text, /node bin\/proof-matrix\.mjs --check/);
});

test('cli: usage errors exit 2, and --write cannot be combined with --only', () => {
  for (const args of [[], ['--check', '--only', 'no-such-tool'], ['--write', '--only', 'x']]) {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
  }
});

test('cli: a fixture with one weak test exits 1 and prints a line per fault and a total', () => {
  const dir = fixture();
  const r = spawnSync(process.execPath, [script, '--check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /MISSED add: The unused helper changes\./);
  assert.match(r.stdout, /2 of 3 faults caught/);
});

test('a fault that makes its test hang is TIMEOUT, which is not CAUGHT', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'lib/wait.mjs'), 'export const wait = () => new Promise((r) => setTimeout(r, 0));\n');
  fs.writeFileSync(path.join(dir, 'test/wait.test.mjs'), "import test from 'node:test';\nimport { wait } from '../lib/wait.mjs';\ntest('waits', async () => { await wait(); });\n");
  fs.writeFileSync(
    path.join(dir, 'proof/faults/add.json'),
    JSON.stringify({ name: 'add', kind: 'guard', what: 'Waits.', faults: [{ fault: 'The wait takes 6 seconds.', file: 'lib/wait.mjs', find: 'r, 0)', replace: 'r, 6000)', test: 'node --test test/wait.test.mjs' }] }),
  );
  const run = runMatrix({ root: dir, timeout: 3 });
  assert.deepEqual(run.results.map((r) => r.status), ['TIMEOUT']);
  assert.equal(run.caught, 0);
});
