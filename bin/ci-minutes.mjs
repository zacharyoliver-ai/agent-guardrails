#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';

/** Whole minutes for a list of jobs; each job rounds up on its own. Unfinished jobs count nothing. */
export function billableMinutes(jobs) {
  let total = 0;
  for (const job of jobs || []) {
    const start = Date.parse(job && job.started_at);
    const end = Date.parse(job && job.completed_at);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) continue;
    total += Math.ceil((end - start) / 60000);
  }
  return total;
}

/** today is the day of the month (1-based) and counts as elapsed. */
export function paceReport({ used, cap, reserve, today, daysInMonth }) {
  const projected = Math.round((used / today) * daysInMonth);
  const daysLeft = daysInMonth - today;
  const left = cap - reserve - used;
  const safeDaily = daysLeft > 0 ? Math.max(0, Math.floor(left / daysLeft)) : Math.max(0, left);
  let status = 'OK';
  if (projected > cap - reserve) status = 'OVER';
  else if (projected > cap * 0.8) status = 'WATCH';
  return { used, projected, safeDaily, daysLeft, status };
}

/** gh api --paginate prints one JSON document per page, back to back. */
export function parseDocuments(text) {
  const docs = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      if (depth++ === 0) start = i;
    } else if ((c === '}' || c === ']') && --depth === 0) docs.push(JSON.parse(text.slice(start, i + 1)));
  }
  return docs;
}

const ghRunner = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

/** Sums billable minutes for every run created since monthStart (YYYY-MM-DD). */
export function collectMinutes({ repo, runner = ghRunner, monthStart, maxRuns = 500, cacheFile }) {
  const runs = parseDocuments(runner(['api', '--paginate', `repos/${repo}/actions/runs?created=>=${monthStart}&per_page=100`]))
    .flatMap((d) => d.workflow_runs || []);
  const cache = cacheFile ? readCache(cacheFile) : {};
  let used = 0;
  let fetched = 0;
  let skipped = 0;
  for (const run of runs) {
    if (cache[run.id] !== undefined) {
      used += cache[run.id];
      continue;
    }
    if (fetched >= maxRuns) {
      skipped++;
      continue;
    }
    fetched++;
    const jobs = parseDocuments(runner(['api', '--paginate', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]))
      .flatMap((d) => d.jobs || []);
    const minutes = billableMinutes(jobs);
    used += minutes;
    if (run.status === 'completed' && cacheFile) cache[run.id] = minutes;
  }
  if (cacheFile && fetched) writeCache(cacheFile, cache);
  return { used, runs: runs.length, fetched, capped: skipped > 0, skipped };
}

export function main(argv, { env = process.env, runner = ghRunner, now = new Date() } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' }, cap: { type: 'string' }, reserve: { type: 'string', default: '0' },
        'max-runs': { type: 'string', default: '500' }, json: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`ci-minutes: ${err.message}\n`);
    return 2;
  }
  const cap = Number(values.cap);
  const reserve = Number(values.reserve);
  const maxRuns = Number(values['max-runs']);
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo || '') || !(cap > 0) || !(reserve >= 0) || reserve >= cap || !(maxRuns >= 0)) {
    process.stderr.write('usage: ci-minutes --repo owner/name --cap <minutes> [--reserve <minutes>] [--max-runs n] [--json]\n');
    return 2;
  }
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const dir = env.GUARDRAILS_STATE_DIR || path.join(os.tmpdir(), 'agent-guardrails');
  const cacheFile = path.join(dir, `ci-minutes-${values.repo.replace(/[^\w.-]/g, '_')}-${monthStart}.json`);

  let found;
  try {
    found = collectMinutes({ repo: values.repo, runner, monthStart, maxRuns, cacheFile });
  } catch (err) {
    process.stderr.write(`ci-minutes: could not read the GitHub API: ${String(err.message).split(/\r?\n/)[0]}\n`);
    return 2;
  }
  const pace = paceReport({
    used: found.used, cap, reserve, today: now.getUTCDate(), daysInMonth: new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
  });
  if (values.json) process.stdout.write(JSON.stringify({ repo: values.repo, cap, reserve, ...pace, ...found }, null, 2) + '\n');
  else {
    process.stdout.write(
      [
        `${values.repo}  ${monthStart.slice(0, 7)}  ${pace.status}`,
        `used ${pace.used} of ${cap} minutes (reserve ${reserve})`,
        `projected month end ${pace.projected}`,
        `safe daily use for the ${pace.daysLeft} days left: ${pace.safeDaily}`,
        found.capped ? `Hit --max-runs ${maxRuns}: ${found.skipped} runs not counted, so used is a floor. Run again to continue.` : null,
      ].filter(Boolean).join('\n') + '\n',
    );
  }
  return pace.status === 'OVER' ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
