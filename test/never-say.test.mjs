import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkNeverSay } from '../hooks/never-say.mjs';

const script = fileURLToPath(new URL('../hooks/never-say.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ns-'));
const rulesFile = (rules) => {
  const f = path.join(tmp(), 'rules.json');
  fs.writeFileSync(f, JSON.stringify(rules));
  return f;
};
const RULES = [{ pattern: 'should work', flags: 'i', why: 'a guess', instead: 'run it' }];
const envWith = (rules) => ({ GUARDRAILS_NEVER_SAY: rulesFile(rules) });
const msg = (t) => ({ last_assistant_message: t, cwd: tmp() });

test('allows a message with no listed line', () => {
  assert.equal(checkNeverSay(msg('Ran the suite: 12 passed.'), envWith(RULES)), null);
});

test('sends back a match, naming the words, the why and the instead', () => {
  const r = checkNeverSay(msg('That Should Work now.'), envWith(RULES));
  assert.match(r, /"Should Work"/);
  assert.match(r, /Why: a guess/);
  assert.match(r, /Instead: run it/);
});

test('skips fenced code blocks and blockquote lines', () => {
  const fenced = 'Result:\n```\nit should work\n```\nDone.';
  assert.equal(checkNeverSay(msg(fenced), envWith(RULES)), null);
  assert.equal(checkNeverSay(msg('> it should work\nPlain text.'), envWith(RULES)), null);
  assert.ok(checkNeverSay(msg('```\nx\n```\nit should work'), envWith(RULES)));
});

test('a bad regex is skipped with one stderr line and later rules still apply', () => {
  const rules = [{ pattern: '(' }, ...RULES];
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (c) => (lines.push(String(c)), true);
  let r;
  try {
    r = checkNeverSay(msg('should work'), envWith(rules));
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(r);
  assert.equal(lines.length, 1);
});

test('a missing or non-list rules file allows', () => {
  assert.equal(checkNeverSay(msg('should work'), { GUARDRAILS_NEVER_SAY: path.join(tmp(), 'none.json') }), null);
  assert.equal(checkNeverSay(msg('should work'), envWith({ pattern: 'x' })), null);
});

test('default file is never-say.json in cwd', () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'never-say.json'), JSON.stringify(RULES));
  assert.ok(checkNeverSay({ last_assistant_message: 'should work', cwd }, {}));
});

test('reads the final text from the transcript when the field is absent', () => {
  const f = path.join(tmp(), 't.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'it should work' }] } }) + '\n');
  assert.ok(checkNeverSay({ transcript_path: f, cwd: tmp() }, envWith(RULES)));
});

const run = (input, env = {}) =>
  spawnSync(process.execPath, [script], { input, encoding: 'utf8', env: { ...process.env, ...env } });

test('script: sends back once, then allows when stop_hook_active', () => {
  const env = envWith(RULES);
  const first = run(JSON.stringify({ last_assistant_message: 'should work', cwd: tmp() }), env);
  assert.equal(JSON.parse(first.stdout).decision, 'block');
  const second = run(JSON.stringify({ last_assistant_message: 'should work', cwd: tmp(), stop_hook_active: true }), env);
  assert.equal(second.stdout, '');
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = run('not json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});
