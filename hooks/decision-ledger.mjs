#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain, parseInput, readStdin } from '../lib/hook-io.mjs';
import { addContext, finalText, sendBack } from '../lib/stop-io.mjs';

const DAY = 24 * 60 * 60 * 1000;
const SHOWN_MAX = 5;

const ledgerPath = (input, env) =>
  env.GUARDRAILS_LEDGER || path.join(input.cwd || process.cwd(), '.agent-guardrails', 'decisions.jsonl');
const stateDir = (env) => env.GUARDRAILS_STATE_DIR || path.join(os.tmpdir(), 'agent-guardrails');
const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function append(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

/** Replays the ledger. Returns open decisions, oldest first. Damaged lines are skipped. */
export function openDecisions(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const open = new Map();
  for (const line of text.split(/\r?\n/)) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    if (e.event === 'ask' && e.id) open.set(e.id, { id: e.id, asked_at: e.asked_at, session_id: e.session_id, text: e.text });
    else if ((e.event === 'answer' || e.event === 'withdraw') && e.id) open.delete(e.id);
  }
  return [...open.values()];
}

/** Marker lines of a message: { text, hasRecommendation }. */
export function markerLines(message, marker) {
  const out = [];
  for (const raw of message.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.toLowerCase().startsWith(marker.toLowerCase())) continue;
    const text = line.slice(marker.length).trim();
    if (text) out.push({ text, hasRecommendation: /recommend/i.test(text) });
  }
  return out;
}

/** Records new marker lines; returns the lines that carry no recommendation. */
export function recordAsks(input, env = process.env, now = Date.now()) {
  const marker = env.GUARDRAILS_DECISION_MARKER || 'Your call:';
  const lines = markerLines(finalText(input), marker);
  if (!lines.length) return [];
  const file = ledgerPath(input, env);
  const known = new Set(openDecisions(file).map((d) => normalize(d.text)));
  for (const { text } of lines) {
    const key = normalize(text);
    if (known.has(key)) continue;
    known.add(key);
    const id = 'd' + crypto.createHash('sha1').update(key + now).digest('hex').slice(0, 6);
    append(file, { event: 'ask', id, asked_at: new Date(now).toISOString(), session_id: input.session_id || null, text });
  }
  return lines.filter((l) => !l.hasRecommendation);
}

export function checkStop(input, env = process.env, now = Date.now()) {
  const missing = recordAsks(input, env, now);
  if (!missing.length || input.stop_hook_active === true) return null;
  return `Each question to the person needs your recommendation. Add it to: "${missing[0].text}". The question is already recorded; state your recommendation and the one-line reason, then finish.`;
}

/** Context for a prompt, or null when nothing changed since this session last saw it. */
export function promptContext(input, env = process.env, now = Date.now()) {
  const open = openDecisions(ledgerPath(input, env));
  if (!open.length) return null;
  const sig = crypto.createHash('sha1').update(open.map((d) => d.id).join(',')).digest('hex');
  const key = String(input.session_id || 'unknown').replace(/[^\w-]/g, '_');
  const file = path.join(stateDir(env), `ledger-${key}.json`);
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // no earlier view
  }
  if (seen.sig === sig && now - seen.shown_at < DAY) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sig, shown_at: now }));

  const rows = open.slice(0, SHOWN_MAX).map((d) => `- ${d.id}: ${d.text}`);
  if (open.length > SHOWN_MAX) rows.push(`- and ${open.length - SHOWN_MAX} more (run decision-ledger.mjs --list)`);
  return `Questions still waiting on the person (asked earlier, not yet answered). Raise them again when it fits, restating each question in full:\n${rows.join('\n')}`;
}

function cli(args, env, file) {
  const [cmd, id, ...rest] = args;
  const words = rest.join(' ').trim();
  if (cmd === '--list') {
    for (const d of openDecisions(file)) process.stdout.write(`${d.id}  ${d.asked_at}  ${d.text}\n`);
    return 0;
  }
  if (cmd !== '--answer' && cmd !== '--withdraw') {
    process.stderr.write('usage: decision-ledger.mjs --list | --answer <id> "<their words>" | --withdraw <id> "<reason>"\n');
    return 2;
  }
  if (!words) {
    process.stderr.write(`${cmd} needs ${cmd === '--answer' ? 'their words' : 'a reason'}\n`);
    return 2;
  }
  if (!openDecisions(file).some((d) => d.id === id)) {
    process.stderr.write(`no open decision with id ${id}\n`);
    return 2;
  }
  const answer = cmd === '--answer';
  append(file, { event: answer ? 'answer' : 'withdraw', id, at: new Date().toISOString(), [answer ? 'words' : 'reason']: words });
  process.stdout.write(`${answer ? 'answered' : 'withdrawn'} ${id}\n`);
  return 0;
}

export async function main(env = process.env) {
  const args = process.argv.slice(2);
  if (args[0]?.startsWith('--')) {
    process.exitCode = cli(args, env, ledgerPath({}, env));
    return;
  }
  try {
    const input = parseInput(await readStdin());
    if (!input) return void process.stderr.write('decision-ledger: could not parse hook input, allowing\n');
    if (input.hook_event_name === 'UserPromptSubmit') {
      const ctx = promptContext(input, env);
      if (ctx) addContext(ctx);
    } else {
      const reason = checkStop(input, env);
      if (reason) sendBack(reason);
    }
  } catch (err) {
    process.stderr.write(`decision-ledger: ${err.message}, allowing\n`);
  }
}

if (isMain(import.meta.url)) await main();
