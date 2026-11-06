import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { plantedFault } from '../bin/planted-fault.mjs';

const cli = fileURLToPath(new URL('../bin/planted-fault.mjs', import.meta.url));
const MODULE = 'export const add = (a, b) => a + b;\r\nexport const twice = (a) => a + a;\r\n// café\r\n';

function sample(testBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pf-'));
  const file = path.join(dir, 'x.mjs');
  fs.writeFileSync(file, MODULE);
  fs.writeFileSync(path.join(dir, 'x.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from './x.mjs';\ntest('t', () => { ${testBody} });\n`);
  return { dir, file, original: fs.readFileSync(file) };
}
const cmd = 'node --test x.test.mjs';
const same = (s) => assert.ok(fs.readFileSync(s.file).equals(s.original), 'file restored byte for byte');

test('CAUGHT when the test fails on the fault', () => {
  const s = sample('assert.equal(m.add(2, 3), 5);');
  const r = plantedFault({ file: s.file, find: 'a + b', replace: 'a - b', test: cmd, cwd: s.dir });
  assert.equal(r.code, 0);
  assert.match(r.message, /^CAUGHT: the test failed on the planted fault/);
  same(s);
});

test('MISSED when the test still passes', () => {
  const s = sample('assert.equal(typeof m.add, "function");');
  const r = plantedFault({ file: s.file, find: 'a + b', replace: 'a - b', test: cmd, cwd: s.dir });
  assert.equal(r.code, 1);
  assert.match(r.message, /^MISSED: the test still passes with the fault in place/);
  same(s);
});

test('exit 2 when --find is not unique, or missing', () => {
  const s = sample('assert.equal(m.add(2, 3), 5);');
  const many = plantedFault({ file: s.file, find: 'export', replace: 'x', test: cmd, cwd: s.dir });
  assert.equal(many.code, 2);
  assert.match(many.message, /exactly once.*2 times/);
  const none = plantedFault({ file: s.file, find: 'nowhere', replace: 'x', test: cmd, cwd: s.dir });
  assert.equal(none.code, 2);
  assert.match(none.message, /0 times/);
  same(s);
});

test('exit 2 when the test is red at the start', () => {
  const s = sample('assert.equal(m.add(2, 3), 99);');
  const r = plantedFault({ file: s.file, find: 'a + b', replace: 'a - b', test: cmd, cwd: s.dir });
  assert.equal(r.code, 2);
  assert.match(r.message, /does not pass before/);
  same(s);
});

test('cli: exit codes and usage', () => {
  const s = sample('assert.equal(m.add(2, 3), 5);');
  const args = ['--file', s.file, '--find', 'a + b', '--replace', 'a - b', '--test', cmd];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ok = spawnSync(process.execPath, [cli, ...args], { cwd: s.dir, encoding: 'utf8', env });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /CAUGHT/);
  same(s);
  const bad = spawnSync(process.execPath, [cli, '--file', s.file], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Usage/);
});
