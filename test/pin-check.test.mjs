import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkPins } from '../bin/pin-check.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const script = fileURLToPath(new URL('../bin/pin-check.mjs', import.meta.url));
const SENTENCE = 'You are responsible for the messages sent from your account.';

function project(files) {
  const dir = tmpDir('ag-pin-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const must = (file, text, why = 'legal') => ({ file, must: text, why });

test('a pinned sentence that is present passes', () => {
  const dir = project({ 'docs/terms.md': `# Terms\n\n${SENTENCE}\n` });
  assert.deepEqual(checkPins([must('docs/terms.md', SENTENCE)], dir), []);
});

test('reworded text is a finding that carries the why', () => {
  const dir = project({ 'docs/terms.md': 'You are accountable for the messages sent from your account.\n' });
  const out = checkPins([must('docs/terms.md', SENTENCE, 'lawyer wording')], dir);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'docs/terms.md');
  assert.match(out[0].problem, /gone or changed/);
  assert.equal(out[0].why, 'lawyer wording');
});

test('matching is byte exact apart from line endings', () => {
  const dir = project({ 'a.md': 'one\r\ntwo\r\n' });
  assert.deepEqual(checkPins([must('a.md', 'one\ntwo')], dir), []);
  assert.deepEqual(checkPins([must('a.md', 'one\r\ntwo')], dir), []);
  assert.equal(checkPins([must('a.md', 'One\ntwo')], dir).length, 1);
  assert.equal(checkPins([must('a.md', 'one  two')], dir).length, 1);
  assert.equal(checkPins([must('a.md', 'one\n two')], dir).length, 1);
});

test('a missing pinned file is a finding', () => {
  const dir = project({ 'other.md': 'x' });
  const out = checkPins([must('docs/terms.md', SENTENCE)], dir);
  assert.equal(out.length, 1);
  assert.match(out[0].problem, /missing/);
});

test('mustNot flags forbidden text in every matching file, with its line', () => {
  const dir = project({ 'src/a.js': 'ok\nTODO(legal) fix\n', 'src/deep/b.js': 'TODO(legal)', 'src/c.js': 'fine', 'lib/d.js': 'TODO(legal)' });
  const out = checkPins([{ glob: 'src/**', mustNot: 'TODO(legal)', why: 'no placeholders' }], dir);
  assert.deepEqual(out.map((f) => f.file).sort(), ['src/a.js', 'src/deep/b.js']);
  assert.equal(out.find((f) => f.file === 'src/a.js').line, 2);
});

test('a glob must-pin needs every matching file to hold the text, and a glob matching nothing fails', () => {
  const dir = project({ 'docs/a.md': 'footer', 'docs/b.md': 'no' });
  const out = checkPins([{ glob: 'docs/*.md', must: 'footer', why: 'w' }], dir);
  assert.deepEqual(out.map((f) => f.file), ['docs/b.md']);
  assert.match(checkPins([{ glob: 'nothing/**', must: 'x', why: 'w' }], dir)[0].problem, /no file matches/);
  assert.deepEqual(checkPins([{ glob: 'nothing/**', mustNot: 'x', why: 'w' }], dir), []);
});

test('node_modules is not scanned', () => {
  const dir = project({ 'node_modules/p/x.js': 'TODO(legal)' });
  assert.deepEqual(checkPins([{ glob: '**/*.js', mustNot: 'TODO(legal)', why: 'w' }], dir), []);
});

test('a malformed pin throws', () => {
  assert.throws(() => checkPins([{ file: 'a', glob: 'b', must: 'x' }], '.'), /exactly one of "file" or "glob"/);
  assert.throws(() => checkPins([{ file: 'a' }], '.'), /"must" or "mustNot"/);
  assert.throws(() => checkPins({}, '.'), /list/);
});

test('cli: exit 0 when held, 1 with a readable line when broken, --json prints findings', () => {
  const dir = project({ 'docs/terms.md': SENTENCE, 'pins.json': JSON.stringify([must('docs/terms.md', SENTENCE)]) });
  assert.equal(spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' }).status, 0);
  fs.writeFileSync(path.join(dir, 'docs/terms.md'), 'changed');
  const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /docs\/terms\.md: the pinned wording is gone/);
  assert.match(r.stdout, /why it is pinned: legal/);
  const j = spawnSync(process.execPath, [script, '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(JSON.parse(j.stdout).length, 1);
});

test('cli: --pins and --root, and exit 2 for a missing or invalid pins file', () => {
  const dir = project({ 'x.md': 'hello', 'p/my.json': JSON.stringify([must('x.md', 'hello')]), 'bad.json': '{nope' });
  const run = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8' });
  assert.equal(run('--pins', path.join(dir, 'p/my.json'), '--root', dir).status, 0);
  assert.equal(run('--pins', path.join(dir, 'missing.json')).status, 2);
  assert.equal(run('--pins', path.join(dir, 'bad.json')).status, 2);
});

test("the shipped example parses and every pin is well formed", () => {
  const pins = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../examples/pins.json', import.meta.url)), 'utf8'));
  const dir = project({});
  assert.ok(checkPins(pins, dir).length >= 2); // none of the example files exist in an empty folder
});
