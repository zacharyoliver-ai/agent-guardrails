import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkStop, openDecisions, promptContext } from '../hooks/decision-ledger.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const script = fileURLToPath(new URL('../hooks/decision-ledger.mjs', import.meta.url));
const tmp = () => tmpDir('ag-dl-');
const setup = () => {
  const dir = tmp();
  return { dir, env: { GUARDRAILS_LEDGER: path.join(dir, 'l.jsonl'), GUARDRAILS_STATE_DIR: path.join(dir, 'state') } };
};
const stop = (msg, extra = {}) => ({ session_id: 's1', last_assistant_message: msg, ...extra });
const NOW = Date.parse('2030-01-01T00:00:00Z');

test('a marker line with a recommendation is recorded and allowed', () => {
  const { env } = setup();
  assert.equal(checkStop(stop('Your call: ship now or wait? I recommend waiting.'), env, NOW), null);
  const open = openDecisions(env.GUARDRAILS_LEDGER);
  assert.equal(open.length, 1);
  assert.equal(open[0].session_id, 's1');
  assert.equal(open[0].asked_at, '2030-01-01T00:00:00.000Z');
});

test('a marker line without a recommendation goes back once and is recorded only on the retry', () => {
  const { env } = setup();
  const r = checkStop(stop('Your call: ship now or wait?'), env, NOW);
  assert.match(r, /recommendation/);
  assert.equal(openDecisions(env.GUARDRAILS_LEDGER).length, 0);
  assert.equal(checkStop(stop('Your call: ship now or wait?', { stop_hook_active: true }), env, NOW), null);
  assert.equal(openDecisions(env.GUARDRAILS_LEDGER).length, 1);
});

test('the retry that adds a recommendation leaves exactly one open decision', () => {
  const { env } = setup();
  assert.match(checkStop(stop('Your call: ship it now?'), env, NOW), /recommendation/);
  assert.equal(checkStop(stop('Your call: ship it now? I recommend yes, tests pass.', { stop_hook_active: true }), env, NOW + 1), null);
  assert.deepEqual(openDecisions(env.GUARDRAILS_LEDGER).map((d) => d.text), ['ship it now? I recommend yes, tests pass.']);
});

test('the first ledger write adds a .gitignore holding * beside a default ledger', () => {
  const cwd = tmp();
  const env = { GUARDRAILS_STATE_DIR: path.join(cwd, 'state') };
  checkStop({ session_id: 's1', cwd, last_assistant_message: 'Your call: A? I recommend yes.' }, env, NOW);
  const dir = path.join(cwd, '.agent-guardrails');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
  checkStop({ session_id: 's1', cwd, last_assistant_message: 'Your call: B? I recommend no.' }, env, NOW + 1);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
  assert.ok(fs.existsSync(path.join(dir, 'decisions.jsonl')));
});

test('writing prompt context deletes ledger state files older than 30 days and keeps the rest', () => {
  const { env } = setup();
  checkStop(stop('Your call: A? I recommend yes.'), env, NOW);
  fs.mkdirSync(env.GUARDRAILS_STATE_DIR, { recursive: true });
  const old = path.join(env.GUARDRAILS_STATE_DIR, 'ledger-old.json');
  const fresh = path.join(env.GUARDRAILS_STATE_DIR, 'ledger-fresh.json');
  const other = path.join(env.GUARDRAILS_STATE_DIR, 'fleet-old.json');
  for (const f of [old, fresh, other]) fs.writeFileSync(f, '{}');
  const when = (days) => new Date(NOW - days * 86400000);
  fs.utimesSync(old, when(31), when(31));
  fs.utimesSync(other, when(31), when(31));
  fs.utimesSync(fresh, when(29), when(29));
  promptContext({ session_id: 's1' }, env, NOW);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(other), true);
});

test('the same question is recorded once, ignoring case and punctuation', () => {
  const { env } = setup();
  checkStop(stop('Your call: Ship now? I recommend yes.'), env, NOW);
  checkStop(stop('Your call: ship NOW - I recommend yes'), env, NOW + 1);
  checkStop(stop('Your call: ship now? i recommend yes!'), env, NOW + 2);
  assert.equal(openDecisions(env.GUARDRAILS_LEDGER).length, 1);
});

test('a message without the marker records nothing, and the marker is configurable', () => {
  const { env } = setup();
  assert.equal(checkStop(stop('Nothing to ask. Your call is mine.'), env, NOW), null);
  assert.equal(openDecisions(env.GUARDRAILS_LEDGER).length, 0);
  checkStop(stop('Question for you: tabs or spaces? I recommend spaces.'), { ...env, GUARDRAILS_DECISION_MARKER: 'Question for you:' }, NOW);
  assert.equal(openDecisions(env.GUARDRAILS_LEDGER).length, 1);
});

test('prompt context lists open decisions once, and again when the list changes', () => {
  const { env } = setup();
  checkStop(stop('Your call: A? I recommend yes.'), env, NOW);
  const first = promptContext({ session_id: 's1' }, env, NOW + 1000);
  assert.match(first, /A\?/);
  assert.equal(promptContext({ session_id: 's1' }, env, NOW + 2000), null);
  checkStop(stop('Your call: B? I recommend no.'), env, NOW + 3000);
  assert.match(promptContext({ session_id: 's1' }, env, NOW + 4000), /B\?/);
  assert.ok(promptContext({ session_id: 's2' }, env, NOW + 4000), 'another session has its own view');
});

test('prompt context repeats after 24 hours and caps at five lines', () => {
  const { env } = setup();
  for (let i = 0; i < 7; i++) checkStop(stop(`Your call: question number ${i}? I recommend yes.`), env, NOW + i);
  const ctx = promptContext({ session_id: 's1' }, env, NOW + 1000);
  assert.equal(ctx.split('\n').filter((l) => l.startsWith('- d')).length, 5);
  assert.match(ctx, /2 more/);
  assert.equal(promptContext({ session_id: 's1' }, env, NOW + 23 * 3600 * 1000), null);
  assert.ok(promptContext({ session_id: 's1' }, env, NOW + 25 * 3600 * 1000));
});

test('no open decisions means no context', () => {
  const { env } = setup();
  assert.equal(promptContext({ session_id: 's1' }, env, NOW), null);
});

test('a damaged ledger line is skipped', () => {
  const { env } = setup();
  checkStop(stop('Your call: A? I recommend yes.'), env, NOW);
  fs.appendFileSync(env.GUARDRAILS_LEDGER, '{broken\n');
  assert.equal(openDecisions(env.GUARDRAILS_LEDGER).length, 1);
});

const cli = (env, ...args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('cli: list, answer and withdraw remove a decision; nothing else does', () => {
  const { env } = setup();
  checkStop(stop('Your call: A? I recommend yes.'), env, NOW);
  checkStop(stop('Your call: B? I recommend no.'), env, NOW + 1);
  const [a, b] = openDecisions(env.GUARDRAILS_LEDGER);
  assert.match(cli(env, '--list').stdout, /A\?/);
  assert.equal(cli(env, '--answer', a.id, 'yes, go').status, 0);
  assert.equal(cli(env, '--withdraw', b.id, 'no longer needed').status, 0);
  assert.equal(openDecisions(env.GUARDRAILS_LEDGER).length, 0);
  const log = fs.readFileSync(env.GUARDRAILS_LEDGER, 'utf8');
  assert.match(log, /"words":"yes, go"/);
  assert.match(log, /"reason":"no longer needed"/);
});

test('cli: empty words and unknown ids exit 2 and change nothing', () => {
  const { env } = setup();
  checkStop(stop('Your call: A? I recommend yes.'), env, NOW);
  const [a] = openDecisions(env.GUARDRAILS_LEDGER);
  assert.equal(cli(env, '--answer', a.id).status, 2);
  assert.equal(cli(env, '--answer', a.id, '   ').status, 2);
  assert.equal(cli(env, '--withdraw', a.id).status, 2);
  assert.equal(cli(env, '--answer', 'dnope', 'yes').status, 2);
  assert.equal(cli(env, '--answer', a.id, 'yes').status, 0);
  assert.equal(cli(env, '--answer', a.id, 'yes again').status, 2, 'an answered id is no longer open');
  assert.equal(cli(env, '--bogus').status, 2);
});

test('script: Stop and UserPromptSubmit through stdin', () => {
  const { env } = setup();
  const full = { ...process.env, ...env };
  const run = (input) => spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: full });
  const s = run({ hook_event_name: 'Stop', session_id: 'x', last_assistant_message: 'Your call: go?' });
  assert.equal(JSON.parse(s.stdout).decision, 'block');
  assert.equal(run({ hook_event_name: 'Stop', session_id: 'x', stop_hook_active: true, last_assistant_message: 'Your call: go?' }).stdout, '');
  const p = run({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'hi' });
  const out = JSON.parse(p.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /go\?/);
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'again' }).stdout, '');
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});
