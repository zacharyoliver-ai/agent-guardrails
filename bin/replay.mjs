#!/usr/bin/env node
// Replays past Claude Code sessions through the stateless guards, in this process.
// Nothing is installed and nothing is written.
import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';
import { defaultDir, findTranscripts, parseSince } from './usage-report.mjs';
import { check as gitGuard } from '../hooks/git-guard.mjs';
import { check as secretGuard, findCredential } from '../hooks/secret-guard.mjs';
import { check as bulkWriteGate } from '../hooks/bulk-write-gate.mjs';
import { check as foregroundWait } from '../hooks/foreground-wait.mjs';
import { checkLadder } from '../hooks/model-ladder.mjs';

export const GUARDS = [
  ['git-guard', gitGuard],
  ['secret-guard', (input) => secretGuard(input)],
  ['bulk-write-gate', bulkWriteGate],
  ['foreground-wait', foregroundWait],
  ['model-ladder', checkLadder],
];

// Guards see only these variables, so a user's own config or state files are never read.
const guardEnv = (env) => ({ PATH: env.PATH, HOME: env.HOME, USERPROFILE: env.USERPROFILE });

/** Replaces every word that holds a credential shape with [masked]. */
export function mask(text) {
  return text.split(/(\s+)/).map((w) => (findCredential(w) ? '[masked]' : w)).join('');
}

function describe(input, reason) {
  const first = reason.split(/(?<=[.!?])\s/)[0];
  const ti = input.tool_input || {};
  const what = typeof ti.command === 'string' ? ti.command : JSON.stringify(ti);
  const shown = mask(what.replace(/\s+/g, ' ')).slice(0, 80);
  return `${mask(first)} | ${input.tool_name}: ${shown}`;
}

/** Reads one transcript and returns its tool_use blocks and the count of damaged lines. */
async function readCalls(file, seen) {
  const calls = [];
  let damaged = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const text of rl) {
    if (!text.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      damaged++;
      continue;
    }
    const content = obj?.type === 'assistant' ? obj.message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
      if (block.id) {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
      }
      calls.push({
        tool_name: block.name,
        tool_input: block.input && typeof block.input === 'object' ? block.input : {},
        cwd: obj.cwd || process.cwd(),
        session_id: obj.sessionId || 'replay',
        hook_event_name: 'PreToolUse',
      });
    }
  }
  return { calls, damaged };
}

export async function replay({ dir, sinceMs = 0, show = false, env = process.env }) {
  const genv = guardEnv(env);
  const guards = Object.fromEntries(GUARDS.map(([name]) => [name, { denied: 0, examples: [] }]));
  const seen = new Set();
  let sessions = 0;
  let toolCalls = 0;
  let damaged = 0;
  for (const file of findTranscripts(dir)) {
    if (sinceMs && fs.statSync(file).mtimeMs < sinceMs) continue;
    sessions++;
    const r = await readCalls(file, seen);
    damaged += r.damaged;
    for (const input of r.calls) {
      toolCalls++;
      for (const [name, fn] of GUARDS) {
        let reason = null;
        try {
          reason = fn(input, genv);
        } catch {
          // a guard that throws fails open, as it would in a session
        }
        if (!reason) continue;
        guards[name].denied++;
        if (show && guards[name].examples.length < 5) guards[name].examples.push(describe(input, reason));
      }
    }
  }
  return { sessions, toolCalls, damaged, guards };
}

export function format(report, show) {
  const lines = [`Sessions read: ${report.sessions}`, `Tool calls read: ${report.toolCalls}`];
  if (report.damaged) lines.push(`Damaged lines skipped: ${report.damaged}`);
  lines.push('');
  const rows = Object.entries(report.guards).sort((a, b) => b[1].denied - a[1].denied || a[0].localeCompare(b[0]));
  const width = Math.max(...rows.map(([n]) => n.length));
  for (const [name, g] of rows) {
    lines.push(`${name.padEnd(width)}  would have denied ${g.denied}`);
    if (show) for (const ex of g.examples) lines.push(`    ${ex}`);
  }
  return lines.join('\n');
}

export async function main(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' }, since: { type: 'string' },
        json: { type: 'boolean', default: false }, show: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`replay: ${err.message}\n`);
    return 2;
  }
  let sinceMs = 0;
  if (values.since) {
    sinceMs = parseSince(values.since);
    if (sinceMs === null) {
      process.stderr.write('replay: --since takes 24h, 7d or YYYY-MM-DD\n');
      return 2;
    }
  }
  const dir = values.dir || defaultDir(env);
  if (!fs.existsSync(dir)) {
    process.stderr.write(`replay: folder not found: ${dir}\n`);
    return 2;
  }
  const report = await replay({ dir, sinceMs, show: values.show, env });
  if (values.json) {
    const out = Object.fromEntries(Object.entries(report.guards).map(([k, g]) => [k, values.show ? g : { denied: g.denied }]));
    console.log(JSON.stringify({ ...report, guards: out }, null, 2));
  } else {
    console.log(format(report, values.show));
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
