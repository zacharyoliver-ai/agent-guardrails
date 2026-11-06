import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkFleet } from '../hooks/fleet-cap.mjs';

const script = fileURLToPath(new URL('../hooks/fleet-cap.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fleet-'));
let n = 0;
const start = (model, session = 's1', type = 'general') => ({
  session_id: session,
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_use_id: `t${++n}`,
  tool_input: { description: 'd', subagent_type: type, ...(model ? { model } : {}) },
});
const stop = (type = 'general', session = 's1') => ({ session_id: session, hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: type });

test('other tools pass and record nothing', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  assert.equal(checkFleet({ session_id: 's1', tool_name: 'Bash', tool_input: {} }, env), null);
  assert.deepEqual(fs.readdirSync(env.GUARDRAILS_STATE_DIR), []);
});

test('the fourth opus is denied, the reason names the count and the way out', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  for (let i = 0; i < 3; i++) assert.equal(checkFleet(start('opus'), env), null);
  const r = checkFleet(start('claude-opus-4-1'), env);
  assert.match(r, /3 expensive-model subagents/);
  assert.match(r, /cheaper model/);
  assert.match(r, /finish/);
});

test('the eleventh other-model call is denied; no model counts as other', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  for (let i = 0; i < 5; i++) checkFleet(start('sonnet'), env);
  for (let i = 0; i < 5; i++) checkFleet(start(undefined), env);
  assert.match(checkFleet(start('haiku'), env), /10 other subagents/);
  assert.match(checkFleet(start(undefined), env), /cap is 10/);
});

test('the two pools do not borrow from each other', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  for (let i = 0; i < 10; i++) checkFleet(start('sonnet'), env);
  assert.equal(checkFleet(start('opus'), env), null);
});

test('a denied call records nothing', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  for (let i = 0; i < 3; i++) checkFleet(start('opus'), env);
  checkFleet(start('opus'), env);
  const file = path.join(env.GUARDRAILS_STATE_DIR, 'fleet-s1.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 3);
});

test('entries carry tool_use_id, tier, subagent_type and startedAt', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  const input = start('opus', 's1', 'reviewer');
  checkFleet(input, env, 5000);
  const [e] = JSON.parse(fs.readFileSync(path.join(env.GUARDRAILS_STATE_DIR, 'fleet-s1.json'), 'utf8'));
  assert.deepEqual(e, { tool_use_id: input.tool_use_id, tier: 'expensive', subagent_type: 'reviewer', startedAt: 5000 });
});

test('separate sessions do not share counts', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  for (let i = 0; i < 3; i++) checkFleet(start('opus', 'one'), env);
  assert.equal(checkFleet(start('opus', 'two'), env), null);
  assert.match(checkFleet(start('opus', 'one'), env), /cap is 3/);
});

test('a cap frees after SubagentStop, which prints nothing', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  for (let i = 0; i < 3; i++) checkFleet(start('opus'), env);
  assert.equal(checkFleet(stop(), env), null);
  assert.equal(checkFleet(start('opus'), env), null);
});

test('SubagentStop removes the oldest entry of the same subagent_type, else the oldest overall', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  checkFleet(start('sonnet', 's1', 'a'), env, 1);
  checkFleet(start('sonnet', 's1', 'b'), env, 2);
  checkFleet(start('sonnet', 's1', 'a'), env, 3);
  const read = () => JSON.parse(fs.readFileSync(path.join(env.GUARDRAILS_STATE_DIR, 'fleet-s1.json'), 'utf8'));
  checkFleet(stop('b'), env, 4);
  assert.deepEqual(read().map((e) => e.startedAt), [1, 3]);
  checkFleet(stop('zzz'), env, 5);
  assert.deepEqual(read().map((e) => e.startedAt), [3]);
});

test('SubagentStop with nothing recorded is harmless', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  assert.equal(checkFleet(stop(), env), null);
});

test('a cap frees after expiry', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp(), GUARDRAILS_FLEET_TTL_MIN: '10' };
  for (let i = 0; i < 3; i++) checkFleet(start('opus'), env, 0);
  assert.match(checkFleet(start('opus'), env, 9 * 60000), /cap is 3/);
  assert.equal(checkFleet(start('opus'), env, 10 * 60000), null);
});

test('the default expiry is 120 minutes', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  for (let i = 0; i < 3; i++) checkFleet(start('opus'), env, 0);
  assert.match(checkFleet(start('opus'), env, 119 * 60000), /cap is 3/);
  assert.equal(checkFleet(start('opus'), env, 120 * 60000), null);
});

test('a damaged state file starts again from zero', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  fs.writeFileSync(path.join(env.GUARDRAILS_STATE_DIR, 'fleet-s1.json'), '{not json');
  assert.equal(checkFleet(start('opus'), env), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.GUARDRAILS_STATE_DIR, 'fleet-s1.json'), 'utf8')).length, 1);
});

test('GUARDRAILS_FLEET sets the pools and caps', () => {
  const env = { GUARDRAILS_STATE_DIR: tmp() };
  const file = path.join(tmp(), 'fleet.json');
  fs.writeFileSync(file, JSON.stringify({ expensive: ['big'], expensiveCap: 1, otherCap: 2 }));
  env.GUARDRAILS_FLEET = file;
  assert.equal(checkFleet(start('big'), env), null);
  assert.match(checkFleet(start('big'), env), /cap is 1/);
  assert.equal(checkFleet(start('opus'), env), null);
  assert.equal(checkFleet(start('opus'), env), null);
  assert.match(checkFleet(start('opus'), env), /cap is 2/);
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split(/\r?\n/).length, 1);
});

test('script: end to end deny JSON, and SubagentStop prints nothing', () => {
  const env = { ...process.env, GUARDRAILS_STATE_DIR: tmp(), GUARDRAILS_FLEET: path.join(tmp(), 'none.json') };
  const go = (obj) => spawnSync(process.execPath, [script], { input: JSON.stringify(obj), encoding: 'utf8', env });
  // missing config file: defaults, one stderr line per run
  for (let i = 0; i < 3; i++) assert.equal(go(start('opus')).stdout, '');
  assert.equal(JSON.parse(go(start('opus')).stdout).hookSpecificOutput.permissionDecision, 'deny');
  const s = go(stop());
  assert.equal(s.status, 0);
  assert.equal(s.stdout, '');
  assert.equal(go(start('opus')).stdout, '');
});
