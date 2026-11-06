import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkLadder } from '../hooks/model-ladder.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const script = fileURLToPath(new URL('../hooks/model-ladder.mjs', import.meta.url));
const call = (description, model, tool = 'Agent') => ({
  tool_name: tool,
  tool_input: { description, prompt: 'x', subagent_type: 'general', ...(model ? { model } : {}) },
});

test('other tools pass', () => {
  assert.equal(checkLadder({ tool_name: 'Bash', tool_input: { command: 'ls' } }, {}), null);
});

test('a call with no model is refused and the reason names the options', () => {
  const r = checkLadder(call('Fix the parser'), {});
  assert.match(r, /Name a model/);
  assert.match(r, /haiku/);
});

test('Task calls are checked like Agent calls', () => {
  assert.match(checkLadder(call('Fix the parser', undefined, 'Task'), {}), /Name a model/);
});

test('standard model on a build job passes', () => {
  assert.equal(checkLadder(call('Implement the parser', 'sonnet'), {}), null);
});

test('unknown model names pass', () => {
  assert.equal(checkLadder(call('Find the callers', 'gpt-x'), {}), null);
});

test('model names match case-insensitively as substrings', () => {
  assert.match(checkLadder(call('Implement the parser', 'claude-OPUS-4-1'), {}), /Retry with "sonnet"/);
  assert.equal(checkLadder(call('Security sweep', 'claude-opus-4-1'), {}), null);
});

test('expensive model needs an expensive job word', () => {
  assert.match(checkLadder(call('Implement the parser', 'opus'), {}), /reserved for/);
  for (const job of ['Review the diff', 'Security pass', 'Plan the migration', 'Legal wording', 'Architecture sketch', 'Audit the logs']) {
    assert.equal(checkLadder(call(job, 'opus'), {}), null, job);
  }
});

test('a lookup on sonnet or opus is sent to haiku', () => {
  assert.match(checkLadder(call('Find where the token is read', 'sonnet'), {}), /Retry with "haiku"/);
  assert.match(checkLadder(call('Search for usages', 'sonnet'), {}), /haiku/);
  assert.match(checkLadder(call('Look up the config', 'sonnet'), {}), /haiku/);
  assert.match(checkLadder(call('Where is the cache built', 'sonnet'), {}), /haiku/);
  assert.equal(checkLadder(call('Find where the token is read', 'haiku'), {}), null);
});

test('reviews and audits refuse haiku and name opus', () => {
  assert.match(checkLadder(call('Review the change', 'haiku'), {}), /Retry with "opus"/);
  assert.match(checkLadder(call('Audit the logs', 'haiku'), {}), /opus/);
});

test('edge: "Fix the review tool" on opus is allowed because review is named', () => {
  assert.equal(checkLadder(call('Fix the review tool', 'opus'), {}), null);
});

test('edge: "find every caller and fix them" on sonnet is allowed', () => {
  assert.equal(checkLadder(call('find every caller and fix them', 'sonnet'), {}), null);
});

test('edge: whole words only, so "listen" and "account" are not lookups', () => {
  assert.equal(checkLadder(call('Listen for events and wire the handler', 'sonnet'), {}), null);
  assert.equal(checkLadder(call('Account for the edge cases', 'sonnet'), {}), null);
  assert.match(checkLadder(call('List the exports', 'sonnet'), {}), /haiku/);
});

test('a lookup word counts only at the start of the description', () => {
  for (const d of ['Group sends tests and count bug', 'Critique round 12 folder list', 'Finish blast, red, one-spec list', 'Folder list at full depth', 'Opt-outs: 30004 into the permanent list']) {
    assert.equal(checkLadder(call(d, 'sonnet'), {}), null, d);
  }
  for (const d of ['Find and read his profile', 'List direct Postgres clients', 'Find commits that turned three specs red', 'Search for past decisions', 'Where is the retry loop', '  Count the callers']) {
    assert.match(checkLadder(call(d, 'sonnet'), {}), /haiku/, d);
  }
});

test('a read-only agent type may name a review in passing on a cheap model', () => {
  const agent = (description, subagent_type, model) => ({ tool_name: 'Agent', tool_input: { description, prompt: 'x', ...(subagent_type ? { subagent_type } : {}), model } });
  for (const [d, type] of [['Scout: re-derive A2P profile-review limit facts', 'scout'], ["Re-derive the audit's code facts", 'Explore']]) {
    assert.equal(checkLadder(agent(d, type, 'haiku'), {}), null, d);
  }
  assert.match(checkLadder(agent('Review the auth diff', 'general-purpose', 'haiku'), {}), /Retry with "opus"/);
  assert.match(checkLadder(agent('Review the auth diff', undefined, 'haiku'), {}), /Retry with "opus"/);
});

test('GUARDRAILS_LADDER overrides listed keys and keeps the rest', () => {
  const dir = tmpDir('ag-ladder-');
  const file = path.join(dir, 'ladder.json');
  fs.writeFileSync(file, JSON.stringify({ expensiveJobs: ['postmortem'], tiers: { cheap: ['mini'], standard: ['mid'], expensive: ['big'] } }));
  const env = { GUARDRAILS_LADDER: file };
  assert.equal(checkLadder(call('Write the postmortem', 'big'), env), null);
  assert.match(checkLadder(call('Review the diff', 'big'), env), /reserved for postmortem/);
  assert.match(checkLadder(call('Review the diff', 'mini'), env), /Retry with "big"/);
  assert.match(checkLadder(call('Find the callers', 'mid'), env), /Retry with "mini"/);
});

test('a missing or damaged config file falls back to defaults with one stderr line', () => {
  const dir = tmpDir('ag-ladder-');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{oops');
  for (const file of [bad, path.join(dir, 'missing.json')]) {
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify(call('Implement the parser', 'opus')),
      encoding: 'utf8',
      env: { ...process.env, GUARDRAILS_LADDER: file },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim().split(/\r?\n/).length, 1);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /reserved for/);
  }
});

test('shipped example matches the defaults', () => {
  const file = fileURLToPath(new URL('../examples/ladder.json', import.meta.url));
  const r = checkLadder(call('Implement the parser', 'opus'), { GUARDRAILS_LADDER: file });
  assert.match(r, /reserved for review, security, migration, legal, architecture, audit/);
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split(/\r?\n/).length, 1);
});

test('script: end to end deny JSON', () => {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(call('Fix it')), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
