import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkStep } from '../hooks/step-budget.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const script = fileURLToPath(new URL('../hooks/step-budget.mjs', import.meta.url));
const tmp = () => tmpDir('ag-step-');
const envFor = (dir, extra = {}) => ({ GUARDRAILS_STATE_DIR: dir, GUARDRAILS_STEP_WARN: '3', GUARDRAILS_STEP_LIMIT: '5', ...extra });
const call = (tool = 'Bash', id = 'a1') => ({ session_id: 's', agent_id: id, tool_name: tool, tool_input: {} });

test('allows calls under the warn line', () => {
  const env = envFor(tmp());
  for (let i = 0; i < 3; i++) assert.equal(checkStep(call(), env), null);
});

test('denies exactly one call past the warn line', () => {
  const env = envFor(tmp());
  for (let i = 0; i < 3; i++) checkStep(call(), env);
  assert.match(checkStep(call(), env), /hand-off note/);
  assert.equal(checkStep(call(), env), null);
});

test('past the hard limit only read-only tools pass', () => {
  const env = envFor(tmp());
  for (let i = 0; i < 5; i++) checkStep(call(), env);
  assert.match(checkStep(call('Edit'), env), /Step limit/);
  assert.match(checkStep(call('Bash'), env), /Step limit/);
  for (const t of ['Read', 'Grep', 'Glob']) assert.equal(checkStep(call(t), env), null);
});

test('counts per agent_id and falls back to session_id', () => {
  const env = envFor(tmp());
  for (let i = 0; i < 4; i++) checkStep(call('Bash', 'busy'), env);
  assert.equal(checkStep(call('Bash', 'fresh'), env), null);
  const noAgent = { session_id: 'only-session', tool_name: 'Bash', tool_input: {} };
  checkStep(noAgent, env);
  assert.ok(fs.existsSync(path.join(env.GUARDRAILS_STATE_DIR, 'only-session.json')));
});

test('two agents in one session are counted separately', () => {
  const env = envFor(tmp());
  const as = (agent_id) => ({ session_id: 'shared', agent_id, tool_name: 'Bash', tool_input: {} });
  for (let i = 0; i < 3; i++) {
    assert.equal(checkStep(as('one'), env), null);
    assert.equal(checkStep(as('two'), env), null);
  }
  // each is at 3 of 3 warn; a merged counter would have warned at the 4th call overall
  assert.match(checkStep(as('one'), env), /hand-off note/);
  assert.match(checkStep(as('two'), env), /hand-off note/);
});

test('a damaged counter file restarts at zero', () => {
  const env = envFor(tmp());
  fs.writeFileSync(path.join(env.GUARDRAILS_STATE_DIR, 'a1.json'), '{not json');
  assert.equal(checkStep(call(), env), null);
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = spawnSync(process.execPath, [script], { input: 'nope', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('script: end to end allow then deny JSON', () => {
  const env = { ...process.env, ...envFor(tmp(), { GUARDRAILS_STEP_WARN: '1', GUARDRAILS_STEP_LIMIT: '2' }) };
  const run = () => spawnSync(process.execPath, [script], { input: JSON.stringify(call()), encoding: 'utf8', env });
  const first = run();
  assert.equal(first.status, 0);
  assert.equal(first.stdout, '');
  const second = JSON.parse(run().stdout);
  assert.equal(second.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(second.hookSpecificOutput.hookEventName, 'PreToolUse');
});
