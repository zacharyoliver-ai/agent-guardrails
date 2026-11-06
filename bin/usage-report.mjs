#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';

export function defaultDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** "24h", "7d" or "YYYY-MM-DD" to an epoch in ms. Returns null when it is none of those. */
export function parseSince(text, now = Date.now()) {
  const rel = /^(\d+)([hd])$/.exec(text);
  if (rel) return now - Number(rel[1]) * (rel[2] === 'h' ? 3600e3 : 86400e3);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const t = Date.parse(`${text}T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Every .jsonl file under dir, found by hand so it works on Node 18. */
export function findTranscripts(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out.sort();
}

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function usageOf(u) {
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheWrite: Number(u.cache_creation_input_tokens) || 0,
  };
}

/** Reads one transcript. Each API response counts once; repeated ids keep the largest figures. */
export async function scanFile(file, sinceMs = 0) {
  const responses = new Map();
  let damaged = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      damaged++;
      continue;
    }
    const msg = obj && obj.message;
    if (!msg || !msg.usage || typeof msg.usage !== 'object') continue;
    // Claude Code writes these placeholder lines itself; no request reached a model.
    if (msg.model === '<synthetic>') continue;
    if (sinceMs && obj.timestamp) {
      const t = Date.parse(obj.timestamp);
      if (!Number.isNaN(t) && t < sinceMs) continue;
    }
    const id = msg.id || obj.requestId;
    const key = id || `line-${responses.size}`;
    const u = usageOf(msg.usage);
    const prev = responses.get(key);
    if (prev) {
      for (const f of FIELDS) prev.u[f] = Math.max(prev.u[f], u[f]);
      if (msg.model) prev.model = msg.model;
    } else responses.set(key, { u, model: msg.model || 'unknown' });
  }

  const row = { requests: responses.size, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: 0, damaged, byModel: {} };
  for (const { u, model } of responses.values()) {
    const m = (row.byModel[model] ||= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    m.requests++;
    for (const f of FIELDS) {
      row[f] += u[f];
      m[f] += u[f];
    }
    row.peak = Math.max(row.peak, u.input + u.cacheRead + u.cacheWrite);
  }
  row.models = Object.keys(row.byModel).sort();
  return row;
}

export async function buildReport({ dir, sinceMs = 0, maxRequests = 150, maxContext = 250000 }) {
  const root = path.resolve(dir);
  const rows = [];
  let damaged = 0;
  for (const file of findTranscripts(root)) {
    if (sinceMs) {
      try {
        if (fs.statSync(file).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
    }
    const rel = path.relative(root, file).split(path.sep).join('/');
    const row = await scanFile(file, sinceMs);
    damaged += row.damaged;
    if (row.requests === 0) continue;
    const base = path.basename(file, '.jsonl').replace(/^agent-/, '');
    rows.push({
      project: rel.split('/')[0],
      id: base.slice(0, 8),
      kind: rel.includes('/subagents/') ? 'agent' : 'session',
      ...row,
      total: row.input + row.output + row.cacheRead + row.cacheWrite,
      runaway: row.requests > maxRequests || row.peak > maxContext,
    });
  }
  const models = {};
  for (const r of rows) {
    for (const [name, m] of Object.entries(r.byModel)) {
      const t = (models[name] ||= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      t.requests += m.requests;
      for (const f of FIELDS) t[f] += m[f];
    }
  }
  rows.sort((a, b) => b.total - a.total);
  return { rows, models, damaged, runaways: rows.filter((r) => r.runaway).length };
}

function table(headers, body, left = 1) {
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)));
  const cell = (c, i) => (i < left || i === headers.length - 1 && headers[i] === 'flag' ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]));
  const fmt = (r) => r.map(cell).join('  ').trimEnd();
  return [fmt(headers), ...body.map(fmt)].join('\n');
}

export function formatReport(report, top = 20) {
  const n = (x) => String(x);
  const rows = report.rows.slice(0, top).map((r) => [
    r.project, r.id, r.kind, r.models.join(',') || '-', n(r.requests), n(r.input), n(r.output),
    n(r.cacheRead), n(r.cacheWrite), n(r.peak), r.runaway ? 'RUNAWAY' : '',
  ]);
  const lines = [];
  lines.push(rows.length
    ? table(['project', 'id', 'kind', 'models', 'requests', 'input', 'output', 'cache_read', 'cache_write', 'peak_ctx', 'flag'], rows, 4)
    : 'No transcripts in range.');
  lines.push('');
  const mrows = Object.entries(report.models).sort().map(([k, m]) => [k, n(m.requests), n(m.input), n(m.output), n(m.cacheRead), n(m.cacheWrite)]);
  if (mrows.length) lines.push(table(['model', 'requests', 'input', 'output', 'cache_read', 'cache_write'], mrows), '');
  lines.push(`Runaways: ${report.runaways}`);
  if (report.damaged) lines.push(`Damaged lines skipped: ${report.damaged}`);
  return lines.join('\n');
}

export async function main(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' }, since: { type: 'string' }, top: { type: 'string', default: '20' },
        'max-requests': { type: 'string', default: '150' }, 'max-context': { type: 'string', default: '250000' },
        json: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`usage-report: ${err.message}\n`);
    return 2;
  }
  const top = Number(values.top);
  const maxRequests = Number(values['max-requests']);
  const maxContext = Number(values['max-context']);
  if (![top, maxRequests, maxContext].every((x) => Number.isFinite(x) && x > 0)) {
    process.stderr.write('usage-report: --top, --max-requests and --max-context must be positive numbers\n');
    return 2;
  }
  let sinceMs = 0;
  if (values.since) {
    sinceMs = parseSince(values.since);
    if (sinceMs === null) {
      process.stderr.write('usage-report: --since takes 24h, 7d or YYYY-MM-DD\n');
      return 2;
    }
  }
  const dir = values.dir || defaultDir(env);
  if (!fs.existsSync(dir)) {
    process.stderr.write(`usage-report: folder not found: ${dir}\n`);
    return 2;
  }
  const report = await buildReport({ dir, sinceMs, maxRequests, maxContext });
  if (values.json) process.stdout.write(JSON.stringify({ ...report, rows: report.rows.slice(0, top) }, null, 2) + '\n');
  else process.stdout.write(formatReport(report, top) + '\n');
  return report.runaways ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
