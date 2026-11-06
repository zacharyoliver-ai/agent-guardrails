#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain, parseInput, readStdin } from '../lib/hook-io.mjs';
import { addContext } from '../lib/stop-io.mjs';
import { pruneState } from './decision-ledger.mjs';

const MAX_LINES = 40;

const stateDir = (env) => env.GUARDRAILS_STATE_DIR || path.join(os.tmpdir(), 'agent-guardrails');
const lines = (text) => text.split(/\r?\n/);

/** Added and removed lines between two versions, as +/- rows. Order inside the file is not kept. */
export function diffLines(before, after) {
  const count = (arr) => arr.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const left = count(lines(before));
  const right = count(lines(after));
  const rows = [];
  for (const l of lines(before)) {
    if (!l.trim()) continue;
    if ((right.get(l) || 0) < (left.get(l) || 0)) {
      rows.push(`- ${l}`);
      left.set(l, left.get(l) - 1);
    }
  }
  for (const l of lines(after)) {
    if (!l.trim()) continue;
    if ((left.get(l) || 0) < (right.get(l) || 0)) {
      rows.push(`+ ${l}`);
      right.set(l, right.get(l) - 1);
    }
  }
  return rows;
}

/** Returns context text when the file changed since this session last saw it, else null. */
export function decisionsChange(input, env = process.env) {
  const file = env.GUARDRAILS_DECISIONS_FILE || path.join(input.cwd || process.cwd(), 'DECISIONS.md');
  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const key = String(input.session_id || 'unknown').replace(/[^\w-]/g, '_');
  const snap = path.join(stateDir(env), `decisions-${key}.txt`);
  let before = null;
  try {
    before = fs.readFileSync(snap, 'utf8');
  } catch {
    // first prompt of this session
  }
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  pruneState(path.dirname(snap), 'decisions-');
  if (before === current) return null;
  fs.writeFileSync(snap, current);
  if (before === null) return null;

  const rows = diffLines(before, current);
  if (!rows.length) return null;
  const shown = rows.slice(0, MAX_LINES);
  if (rows.length > MAX_LINES) shown.push(`(${rows.length - MAX_LINES} more changed lines; read ${path.basename(file)})`);
  return `${path.basename(file)} changed since your last prompt. These rulings outrank earlier instructions:\n${shown.join('\n')}`;
}

if (isMain(import.meta.url)) {
  try {
    const input = parseInput(await readStdin());
    if (!input) process.stderr.write('decisions-file: could not parse hook input, allowing\n');
    else {
      const ctx = decisionsChange(input);
      if (ctx) addContext(ctx);
    }
  } catch (err) {
    process.stderr.write(`decisions-file: ${err.message}, allowing\n`);
  }
}
