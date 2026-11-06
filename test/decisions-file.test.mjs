import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decisionsChange } from '../hooks/decisions-file.mjs';

const script = fileURLToPath(new URL('../hooks/decisions-file.mjs', import.meta.url));
const setup = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-df-'));
  const file = path.join(dir, 'DECISIONS.md');
  if (content !== undefined) fs.writeFileSync(file, content);
  return { dir, file, env: { GUARDRAILS_DECISIONS_FILE: file, GUARDRAILS_STATE_DIR: path.join(dir, 'state') } };
};
const prompt = (session = 's1') => ({ session_id: session, prompt: 'hi' });

test('first prompt of a session snapshots and prints nothing', () => {
  const { env } = setup('a\nb\n');
  assert.equal(decisionsChange(prompt(), env), null);
});

test('an unchanged file prints nothing', () => {
  const { env } = setup('a\nb\n');
  decisionsChange(prompt(), env);
  assert.equal(decisionsChange(prompt(), env), null);
});

test('a change shows only the added and removed lines, once', () => {
  const { file, env } = setup('keep one\nold ruling\nkeep two\n');
  decisionsChange(prompt(), env);
  fs.writeFileSync(file, 'keep one\nnew ruling\nkeep two\n');
  const ctx = decisionsChange(prompt(), env);
  assert.match(ctx, /^\+ new ruling$/m);
  assert.match(ctx, /^- old ruling$/m);
  assert.doesNotMatch(ctx, /keep one/);
  assert.equal(decisionsChange(prompt(), env), null);
});

test('sessions keep separate snapshots', () => {
  const { file, env } = setup('a\n');
  decisionsChange(prompt('s1'), env);
  fs.writeFileSync(file, 'a\nb\n');
  assert.match(decisionsChange(prompt('s1'), env), /\+ b/);
  assert.equal(decisionsChange(prompt('s2'), env), null, 'a new session starts from the current file');
});

test('output is capped at 40 lines plus a note', () => {
  const { file, env } = setup('start\n');
  decisionsChange(prompt(), env);
  fs.writeFileSync(file, 'start\n' + Array.from({ length: 60 }, (_, i) => `ruling ${i}`).join('\n') + '\n');
  const ctx = decisionsChange(prompt(), env);
  assert.equal(ctx.split('\n').filter((l) => l.startsWith('+ ')).length, 40);
  assert.match(ctx, /20 more changed lines/);
});

test('a missing file prints nothing', () => {
  const { env } = setup();
  assert.equal(decisionsChange(prompt(), env), null);
});

test('the default file is DECISIONS.md under cwd', () => {
  const { dir } = setup('x\n');
  const env = { GUARDRAILS_STATE_DIR: path.join(dir, 'state') };
  assert.equal(decisionsChange({ session_id: 'q', cwd: dir }, env), null);
  fs.writeFileSync(path.join(dir, 'DECISIONS.md'), 'x\ny\n');
  assert.match(decisionsChange({ session_id: 'q', cwd: dir }, env), /\+ y/);
});

test('script: prints additionalContext on change, fails open on bad input', () => {
  const { file, env } = setup('a\n');
  const full = { ...process.env, ...env };
  const run = (stdin) => spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', env: full });
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'z', prompt: 'hi' });
  assert.equal(run(input).stdout, '');
  fs.writeFileSync(file, 'a\nb\n');
  const out = JSON.parse(run(input).stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /\+ b/);
  const bad = run('not json');
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr.trim().split('\n').length, 1);
});
