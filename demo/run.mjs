#!/usr/bin/env node
// Runs every hook as a child process on sample input and shows what an agent tried and what
// the guard did. No Claude and no network. Exits 1 if any scene differs from what it expects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';
import { plantedFault } from '../bin/planted-fault.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = () => 'ghp_' + 'a'.repeat(36); // built at run time so no token-like text sits in the repo

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const agent = (description, model) => ({ tool_name: 'Agent', tool_input: { description, model, subagent_type: 'general-purpose' } });
const stop = (d, text, calls) => {
  const file = path.join(d, 'transcript.jsonl');
  const lines = [{ type: 'user', message: { role: 'user', content: 'please fix the login bug' } }];
  if (calls.length) lines.push({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: calls } });
  lines.push({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text }] } });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { hook_event_name: 'Stop', transcript_path: file, last_assistant_message: text, stop_hook_active: false };
};
const edit = { type: 'tool_use', name: 'Edit', input: { file_path: 'src/login.js' } };
const check = { type: 'tool_use', name: 'Bash', input: { command: 'node --test test/login.test.mjs' } };

// Groups follow the README: Guards, then Stop hooks.
export const SCENES = [
  { group: 'Guards', hook: 'step-budget', tried: 'Edit src/app.js as call 5 of a 4-call limit', expect: 'DENIED',
    env: { GUARDRAILS_STEP_WARN: '2', GUARDRAILS_STEP_LIMIT: '4' },
    setup: (d, fire) => { for (let i = 0; i < 4; i++) fire(bash('echo working')); },
    input: () => ({ tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } }) },
  { group: 'Guards', hook: 'step-budget', tried: 'Read src/app.js as call 5 of a 4-call limit', expect: 'allowed',
    env: { GUARDRAILS_STEP_WARN: '2', GUARDRAILS_STEP_LIMIT: '4' },
    setup: (d, fire) => { for (let i = 0; i < 4; i++) fire(bash('echo working')); },
    input: () => ({ tool_name: 'Read', tool_input: { file_path: 'src/app.js' } }) },

  { group: 'Guards', hook: 'file-ownership', tried: 'lane "api" edits src/web/app.js', expect: 'DENIED', svg: true,
    env: { GUARDRAILS_LANE: 'api' }, setup: (d) => ownersFile(d),
    input: (d) => ({ tool_name: 'Edit', tool_input: { file_path: path.join(d, 'src', 'web', 'app.js') } }) },
  { group: 'Guards', hook: 'file-ownership', tried: 'lane "api" edits src/api/users.js', expect: 'allowed', svg: true,
    env: { GUARDRAILS_LANE: 'api' }, setup: (d) => ownersFile(d),
    input: (d) => ({ tool_name: 'Edit', tool_input: { file_path: path.join(d, 'src', 'api', 'users.js') } }) },

  { group: 'Guards', hook: 'design-seat', tried: 'design agent edits api/routes.js', expect: 'DENIED',
    env: { GUARDRAILS_SEAT: 'design' },
    input: () => ({ tool_name: 'Edit', tool_input: { file_path: 'api/routes.js' } }) },
  { group: 'Guards', hook: 'design-seat', tried: 'design agent edits src/ui/Button.jsx', expect: 'allowed',
    env: { GUARDRAILS_SEAT: 'design' },
    input: () => ({ tool_name: 'Edit', tool_input: { file_path: 'src/ui/Button.jsx' } }) },

  { group: 'Guards', hook: 'model-ladder', tried: 'sonnet subagent sent to "Find where login is defined"', expect: 'DENIED', svg: true,
    input: () => agent('Find where login is defined', 'sonnet') },
  { group: 'Guards', hook: 'model-ladder', tried: 'sonnet subagent sent to "Fix the login bug"', expect: 'allowed', svg: true,
    input: () => agent('Fix the login bug', 'sonnet') },

  { group: 'Guards', hook: 'fleet-cap', tried: 'a fourth opus subagent while three are running', expect: 'DENIED',
    setup: (d, fire) => { for (let i = 0; i < 3; i++) fire(agent('Review the schema', 'opus')); },
    input: () => agent('Review the schema', 'opus') },
  { group: 'Guards', hook: 'fleet-cap', tried: 'a sonnet subagent while three opus ones run', expect: 'allowed',
    setup: (d, fire) => { for (let i = 0; i < 3; i++) fire(agent('Review the schema', 'opus')); },
    input: () => agent('Fix the login bug', 'sonnet') },

  { group: 'Guards', hook: 'foreground-wait', tried: 'npm test in the foreground', expect: 'DENIED',
    input: () => bash('npm test') },
  { group: 'Guards', hook: 'foreground-wait', tried: 'node --test test/login.test.mjs in the foreground', expect: 'allowed',
    input: () => bash('node --test test/login.test.mjs') },

  { group: 'Guards', hook: 'git-guard', tried: 'git add -A', expect: 'DENIED', svg: true,
    input: () => bash('git add -A') },
  { group: 'Guards', hook: 'git-guard', tried: 'git add src/app.js', expect: 'allowed', svg: true,
    input: () => bash('git add src/app.js') },

  { group: 'Guards', hook: 'secret-guard', tried: 'Write a file that holds a GitHub token', expect: 'DENIED',
    input: () => ({ tool_name: 'Write', tool_input: { file_path: 'config.js', content: `const t = "${token()}";` } }) },
  { group: 'Guards', hook: 'secret-guard', tried: 'Write the same file with a placeholder token', expect: 'allowed',
    input: () => ({ tool_name: 'Write', tool_input: { file_path: 'config.js', content: 'const t = process.env.GH_TOKEN; // ghp_xxx' } }) },

  { group: 'Guards', hook: 'bulk-write-gate', tried: 'UPDATE listings SET status = 1', expect: 'DENIED',
    env: { GUARDRAILS_PROTECTED_TABLES: 'listings' },
    input: () => bash('psql -c "UPDATE listings SET status = 1"') },
  { group: 'Guards', hook: 'bulk-write-gate', tried: 'the same UPDATE with a bulk-ok reason', expect: 'allowed',
    env: { GUARDRAILS_PROTECTED_TABLES: 'listings' },
    input: () => bash('psql -c "UPDATE listings SET status = 1 -- bulk-ok: one-time backfill"') },

  { group: 'Stop hooks', hook: 'never-say', tried: 'finish with "That should work now."', expect: 'DENIED',
    setup: (d) => fs.writeFileSync(path.join(d, 'rules.json'), JSON.stringify([{ pattern: '\\bshould (?:now )?work\\b', flags: 'i', why: 'A guess tells the reader nothing.', instead: 'Run it and report what the run showed.' }])),
    env: (d) => ({ GUARDRAILS_NEVER_SAY: path.join(d, 'rules.json') }),
    input: (d) => stop(d, 'That should work now.', []) },
  { group: 'Stop hooks', hook: 'never-say', tried: 'finish with "The login test passes."', expect: 'allowed',
    setup: (d) => fs.writeFileSync(path.join(d, 'rules.json'), JSON.stringify([{ pattern: '\\bshould (?:now )?work\\b', flags: 'i', why: 'A guess tells the reader nothing.', instead: 'Run it and report what the run showed.' }])),
    env: (d) => ({ GUARDRAILS_NEVER_SAY: path.join(d, 'rules.json') }),
    input: (d) => stop(d, 'The login test passes.', []) },

  { group: 'Stop hooks', hook: 'proof-required', tried: 'edit src/login.js, then say "Done, it works."', expect: 'DENIED', svg: true,
    input: (d) => stop(d, 'Done, it works.', [edit]) },
  { group: 'Stop hooks', hook: 'proof-required', tried: 'edit src/login.js, run its test, then say "Done."', expect: 'allowed', svg: true,
    input: (d) => stop(d, 'Done, the login test passes.', [edit, check]) },

  { group: 'Stop hooks', hook: 'decision-ledger', tried: 'ask "Your call: ship it now?" with no recommendation', expect: 'DENIED',
    env: (d) => ({ GUARDRAILS_LEDGER: path.join(d, 'decisions.jsonl') }),
    input: (d) => stop(d, 'Your call: ship it now?', []) },
  { group: 'Stop hooks', hook: 'decision-ledger', tried: 'ask the same, adding "I recommend yes, the tests pass"', expect: 'allowed',
    env: (d) => ({ GUARDRAILS_LEDGER: path.join(d, 'decisions.jsonl') }),
    input: (d) => stop(d, 'Your call: ship it now? I recommend yes, the tests pass.', []) },

  { group: 'Stop hooks', hook: 'decisions-file', tried: 'next prompt after DECISIONS.md gained a ruling', expect: 'TOLD',
    env: (d) => ({ GUARDRAILS_DECISIONS_FILE: path.join(d, 'DECISIONS.md') }),
    setup: (d, fire) => {
      const f = path.join(d, 'DECISIONS.md');
      fs.writeFileSync(f, '- Use two spaces.\n');
      fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
      fs.writeFileSync(f, '- Use two spaces.\n- Never edit generated files.\n');
    },
    input: () => ({ hook_event_name: 'UserPromptSubmit', prompt: 'continue' }) },
  { group: 'Stop hooks', hook: 'decisions-file', tried: 'next prompt when DECISIONS.md has not changed', expect: 'allowed',
    env: (d) => ({ GUARDRAILS_DECISIONS_FILE: path.join(d, 'DECISIONS.md') }),
    setup: (d, fire) => {
      fs.writeFileSync(path.join(d, 'DECISIONS.md'), '- Use two spaces.\n');
      fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    },
    input: () => ({ hook_event_name: 'UserPromptSubmit', prompt: 'continue' }) },
];

function ownersFile(d) {
  fs.mkdirSync(path.join(d, '.guardrails'), { recursive: true });
  fs.writeFileSync(path.join(d, '.guardrails', 'owners.json'), JSON.stringify({ lanes: { api: ['src/api/**'], web: ['src/web/**'] } }));
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GUARDRAILS_') || k === 'NODE_TEST_CONTEXT') delete env[k];
  return env;
}

const firstSentence = (s) => String(s).split(/(?<=\w[.!?])\s+/)[0].replace(/\s+/g, ' ').trim();

/** Runs one hook script on stdin JSON; returns { label, reason }. */
function fireHook(hook, input, env, cwd) {
  const r = spawnSync(process.execPath, [path.join(root, 'hooks', `${hook}.mjs`)], { input: JSON.stringify(input), env, cwd, encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (!out) return { label: 'allowed', reason: '' };
  let v;
  try {
    v = JSON.parse(out);
  } catch {
    return { label: 'ERROR', reason: out.slice(0, 120) };
  }
  const h = v.hookSpecificOutput || {};
  if (h.permissionDecision === 'deny') return { label: 'DENIED', reason: firstSentence(h.permissionDecisionReason) };
  if (v.decision === 'block') return { label: 'DENIED', reason: firstSentence(v.reason) };
  if (h.additionalContext) return { label: 'TOLD', reason: firstSentence(h.additionalContext) };
  return { label: 'allowed', reason: '' };
}

/** Runs scenes in order inside tmp. Each result carries ok: did it match what the scene expects. */
export function runScenes(scenes, tmp) {
  const results = [];
  scenes.forEach((s, i) => {
    const d = path.join(tmp, `scene-${i}`);
    fs.mkdirSync(d, { recursive: true });
    const session = `demo-${i}`;
    const baseEnv = { ...cleanEnv(), GUARDRAILS_STATE_DIR: path.join(d, 'state') };
    const extra = typeof s.env === 'function' ? s.env(d) : s.env || {};
    const env = { ...baseEnv, ...extra };
    const withIds = (input, n) => ({ session_id: session, cwd: d, tool_use_id: `t${n}`, ...input });
    let n = 0;
    const fire = (input) => fireHook(s.hook, withIds(input, n++), env, d);
    if (s.setup) s.setup(d, fire);
    const got = fire(s.input(d));
    results.push({ ...s, label: got.label, reason: got.reason, ok: got.label === s.expect });
  });
  return results;
}

function copyRepo(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyRepo(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

/** Breaks file-ownership in a throwaway copy and runs its own test against it. */
export function liveFault(tmp) {
  const copy = path.join(tmp, 'repo-copy');
  copyRepo(root, copy);
  // The tool's own test leaves temp folders; point them inside tmp so they are removed with it.
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const scratch = path.join(tmp, 'scratch');
  fs.mkdirSync(scratch);
  Object.assign(process.env, { TMPDIR: scratch, TEMP: scratch, TMP: scratch });
  let r;
  try {
    r = plantedFault({
      file: path.join(copy, 'hooks', 'file-ownership.mjs'),
      find: 'if (globs.some((g) => matchGlob(g, rel))) return null;',
      replace: 'if (true) return null;',
      test: 'node --test test/file-ownership.test.mjs',
      cwd: copy,
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return { ok: r.code === 0, text: r.code === 0 ? 'CAUGHT' : 'MISSED', message: r.message };
}

const trim = (s, n) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

function svgFor(results, fault) {
  const rows = [{ k: 'cmd', t: '$ node demo/run.mjs' }, { k: 'gap' }];
  let last = '';
  for (const r of results.filter((x) => x.svg)) {
    if (r.hook !== last) rows.push({ k: 'head', t: r.hook });
    last = r.hook;
    rows.push({ k: 'tried', t: trim(r.tried, 80) });
    rows.push(r.label === 'allowed' ? { k: 'ok', t: 'allowed' } : { k: 'deny', label: r.label, t: trim(r.reason, 76) });
  }
  rows.push({ k: 'gap' }, { k: 'head', t: 'planted fault, run on a throwaway copy' }, { k: 'tried', t: 'file-ownership: every edit allowed' }, { k: fault.ok ? 'ok' : 'deny', label: fault.text, t: fault.ok ? 'its own test failed, as it should' : '' });
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lh = 21;
  const h = 56 + rows.length * lh;
  const body = rows.map((r, i) => {
    const y = 52 + i * lh;
    if (r.k === 'gap') return '';
    if (r.k === 'cmd') return `<text x="24" y="${y}" class="cmd">${esc(r.t)}</text>`;
    if (r.k === 'head') return `<text x="24" y="${y}" class="head">${esc(r.t)}</text>`;
    if (r.k === 'tried') return `<text x="44" y="${y}" class="dim"><tspan class="mute">tried  </tspan><tspan>${esc(r.t)}</tspan></text>`;
    if (r.k === 'ok') return `<text x="44" y="${y}"><tspan class="good">${esc(r.label || 'allowed')}</tspan>${r.t && r.label ? `<tspan class="mute">  ${esc(r.t)}</tspan>` : ''}</text>`;
    return `<text x="44" y="${y}"><tspan class="bad">${esc(r.label)}</tspan><tspan class="mute">  ${esc(r.t)}</tspan></text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 820 ${h}" width="820" height="${h}" role="img" aria-labelledby="t d">
  <title id="t">agent-guardrails demo output</title>
  <desc id="d">Terminal output: several tool calls an agent tried, each either denied with a reason or allowed, then a planted fault caught by the tool's own test.</desc>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13px; fill: #c9d1d9; white-space: pre; }
    .cmd { fill: #e6edf3; font-weight: 700; }
    .head { fill: #8b98a8; font-weight: 700; }
    .mute { fill: #7d8590; }
    .good { fill: #56b872; font-weight: 700; }
    .bad { fill: #f0716a; font-weight: 700; }
  </style>
  <rect x="1" y="1" width="818" height="${h - 2}" rx="12" fill="#0f141a" stroke="#2b333d"/>
  <circle cx="24" cy="22" r="5" fill="#f0716a" opacity="0.7"/><circle cx="42" cy="22" r="5" fill="#d9a441" opacity="0.7"/><circle cx="60" cy="22" r="5" fill="#56b872" opacity="0.7"/>
  ${body.filter(Boolean).join('\n  ')}
</svg>
`;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { svg: { type: 'string' } } });
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-demo-'));
  let results;
  let fault;
  try {
    results = runScenes(SCENES, tmp);
    fault = liveFault(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  let group = '';
  let hook = '';
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      process.stdout.write(`${paint('1', group)}\n`);
    }
    if (r.hook !== hook) {
      hook = r.hook;
      process.stdout.write(`  ${paint('1', r.hook)}\n`);
    }
    const code = r.label === 'allowed' ? '32' : r.label === 'TOLD' ? '33' : '31';
    process.stdout.write(`    ${paint('2', 'tried:')} ${r.tried}\n`);
    process.stdout.write(`    ${paint(code, r.label)}${r.reason ? '  ' + trim(r.reason, 110) : ''}${r.ok ? '' : paint('31', `   <- expected ${r.expect}`)}\n`);
  }
  process.stdout.write(`${paint('1', 'Planted fault')}\n    ${paint('2', 'tried:')} break file-ownership so every edit passes, in a throwaway copy, then run its own test\n`);
  process.stdout.write(`    ${paint(fault.ok ? '32' : '31', fault.text)}\n`);

  const bad = results.filter((r) => !r.ok);
  if (bad.length || !fault.ok) {
    process.stderr.write(`demo: ${bad.length} scene(s) did not match${fault.ok ? '' : ' and the planted fault was missed'}\n`);
    process.exitCode = 1;
  }
  if (values.svg) {
    fs.mkdirSync(path.dirname(path.resolve(values.svg)), { recursive: true });
    fs.writeFileSync(values.svg, svgFor(results, fault));
  }
}

if (isMain(import.meta.url)) await main();
