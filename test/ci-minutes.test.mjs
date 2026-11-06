import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { billableMinutes, collectMinutes, main, paceReport, parseDocuments } from '../bin/ci-minutes.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ci-'));
const job = (seconds) => ({ started_at: '2026-03-01T10:00:00Z', completed_at: new Date(Date.parse('2026-03-01T10:00:00Z') + seconds * 1000).toISOString() });

test('billableMinutes rounds each job up on its own', () => {
  assert.equal(billableMinutes([job(1), job(61), job(60)]), 1 + 2 + 1);
  assert.equal(billableMinutes([]), 0);
});

test('billableMinutes ignores unfinished and invalid jobs', () => {
  assert.equal(billableMinutes([{ started_at: '2026-03-01T10:00:00Z', completed_at: null }, { started_at: null, completed_at: null }, job(30)]), 1);
  assert.equal(billableMinutes([{ started_at: '2026-03-01T10:05:00Z', completed_at: '2026-03-01T10:00:00Z' }]), 0);
});

test('paceReport: on pace is OK, fast pace is WATCH, faster is OVER', () => {
  const base = { cap: 2000, reserve: 200, today: 10, daysInMonth: 30 };
  assert.equal(paceReport({ ...base, used: 400 }).status, 'OK'); // 1200 projected
  const watch = paceReport({ ...base, used: 560 }); // 1680 projected
  assert.equal(watch.status, 'WATCH');
  assert.equal(watch.projected, 1680);
  assert.equal(paceReport({ ...base, used: 620 }).status, 'OVER'); // 1860 > 1800
});

test('paceReport: safeDaily spreads what is left over the days left', () => {
  const r = paceReport({ used: 400, cap: 2000, reserve: 200, today: 10, daysInMonth: 30 });
  assert.equal(r.safeDaily, 70); // 1400 / 20
  assert.equal(r.daysLeft, 20);
});

test('paceReport: first of the month scales one day to the whole month', () => {
  const r = paceReport({ used: 30, cap: 2000, reserve: 200, today: 1, daysInMonth: 30 });
  assert.equal(r.projected, 900);
  assert.equal(r.status, 'OK');
  assert.equal(paceReport({ used: 70, cap: 2000, reserve: 200, today: 1, daysInMonth: 30 }).status, 'OVER');
});

test('paceReport: last day has nothing left to spread, and a passed cap clamps to zero', () => {
  const last = paceReport({ used: 1000, cap: 2000, reserve: 200, today: 30, daysInMonth: 30 });
  assert.equal(last.projected, 1000);
  assert.equal(last.safeDaily, 800);
  const passed = paceReport({ used: 2100, cap: 2000, reserve: 200, today: 15, daysInMonth: 30 });
  assert.equal(passed.status, 'OVER');
  assert.equal(passed.safeDaily, 0);
});

test('parseDocuments splits back-to-back pages and ignores braces inside strings', () => {
  const docs = parseDocuments('{"a":"}{"}\n{"b":[1,{"c":2}]}');
  assert.deepEqual(docs, [{ a: '}{' }, { b: [1, { c: 2 }] }]);
});

function fakeRunner(runs, jobsByRun, calls = []) {
  return (args) => {
    calls.push(args[2]);
    const m = /actions\/runs\/(\d+)\/jobs/.exec(args[2]);
    if (m) return JSON.stringify({ jobs: jobsByRun[m[1]] || [] });
    return JSON.stringify({ workflow_runs: runs.slice(0, 2) }) + JSON.stringify({ workflow_runs: runs.slice(2) });
  };
}

test('collectMinutes sums jobs, caches finished runs and stops at --max-runs', () => {
  const dir = tmp();
  const cacheFile = path.join(dir, 'c.json');
  const runs = [{ id: 1, status: 'completed' }, { id: 2, status: 'completed' }, { id: 3, status: 'in_progress' }];
  const jobs = { 1: [job(60)], 2: [job(120)], 3: [job(10)] };

  const calls = [];
  const first = collectMinutes({ repo: 'o/r', runner: fakeRunner(runs, jobs, calls), monthStart: '2026-03-01', cacheFile });
  assert.equal(first.used, 1 + 2 + 1);
  assert.equal(calls.filter((c) => c.includes('/jobs')).length, 3);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).sort(), ['1', '2']);

  const calls2 = [];
  const again = collectMinutes({ repo: 'o/r', runner: fakeRunner(runs, jobs, calls2), monthStart: '2026-03-01', cacheFile });
  assert.equal(again.used, 4);
  assert.equal(calls2.filter((c) => c.includes('/jobs')).length, 1); // only the unfinished run is fetched again

  const capped = collectMinutes({ repo: 'o/r', runner: fakeRunner(runs, jobs), monthStart: '2026-03-01', maxRuns: 1, cacheFile: path.join(dir, 'other.json') });
  assert.equal(capped.capped, true);
  assert.equal(capped.skipped, 2);
  assert.equal(capped.used, 1);
});

test('billableMinutes multiplies Windows by 2 and macOS by 10, from the job labels', () => {
  const withLabels = (labels) => ({ ...job(61), labels });
  assert.equal(billableMinutes([withLabels(['ubuntu-latest'])]), 2);
  assert.equal(billableMinutes([withLabels(['windows-latest'])]), 4);
  assert.equal(billableMinutes([withLabels(['macos-14'])]), 20);
  assert.equal(billableMinutes([withLabels(['self-hosted', 'Windows', 'X64'])]), 4);
  assert.equal(billableMinutes([job(61)]), 2);
});

test('collectMinutes asks one day at a time, counts a run once, and asks for every attempt', () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args[2]);
    if (args[2].includes('/jobs')) return JSON.stringify({ jobs: [job(60)] });
    const day = /created=([\d-]+)/.exec(args[2])[1];
    return JSON.stringify({ workflow_runs: day === '2026-03-02' ? [{ id: 7, status: 'completed' }, { id: 8, status: 'completed' }] : [{ id: 7, status: 'completed' }] });
  };
  const r = collectMinutes({ repo: 'o/r', runner, monthStart: '2026-03-01', lastDay: '2026-03-03' });
  const searches = calls.filter((c) => c.includes('/actions/runs?'));
  assert.deepEqual(searches.map((c) => /created=([\d-]+)/.exec(c)[1]), ['2026-03-01', '2026-03-02', '2026-03-03']);
  assert.ok(searches.every((c) => !c.includes('>=')));
  assert.equal(r.runs, 2);
  assert.equal(r.used, 2);
  const jobCalls = calls.filter((c) => c.includes('/jobs'));
  assert.equal(jobCalls.length, 2);
  assert.ok(jobCalls.every((c) => c.includes('filter=all')));
});

test('CLI says when the repository is public, and stays quiet when it is private or unknown', () => {
  const now = new Date('2026-03-02T12:00:00Z');
  const withRepo = (priv) => (args) => (args[1] === 'repos/o/r' ? JSON.stringify({ private: priv }) : JSON.stringify({ workflow_runs: [] }));
  const pub = cli(['--repo', 'o/r', '--cap', '2000'], withRepo(false), now);
  assert.match(pub.out, /public/);
  assert.equal(JSON.parse(cli(['--repo', 'o/r', '--cap', '2000', '--json'], withRepo(false), now).out).public, true);
  assert.doesNotMatch(cli(['--repo', 'o/r', '--cap', '2000'], withRepo(true), now).out, /public/);
});

function cli(argv, runner, now) {
  const out = [];
  const err = [];
  const w = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = (s) => (out.push(String(s)), true);
  process.stderr.write = (s) => (err.push(String(s)), true);
  let code;
  try {
    code = main(argv, { env: { GUARDRAILS_STATE_DIR: tmp() }, runner, now });
  } finally {
    process.stdout.write = w;
    process.stderr.write = e;
  }
  return { code, out: out.join(''), err: err.join('') };
}

test('CLI exits 0 under pace and 1 when the month would go over', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const runs = [{ id: 1, status: 'completed' }];
  const small = cli(['--repo', 'o/r', '--cap', '2000', '--reserve', '200'], fakeRunner(runs, { 1: [job(60 * 100)] }), now);
  assert.equal(small.code, 0);
  assert.match(small.out, /OK/);
  const big = cli(['--repo', 'o/r', '--cap', '2000', '--reserve', '200', '--json'], fakeRunner(runs, { 1: [job(60 * 700)] }), now);
  assert.equal(big.code, 1);
  assert.equal(JSON.parse(big.out).status, 'OVER');
});

test('CLI reports a usage error and a failing gh call with exit 2', () => {
  assert.equal(cli(['--cap', '10'], () => '', new Date()).code, 2);
  assert.equal(cli(['--repo', 'o/r', '--cap', '100', '--reserve', '100'], () => '', new Date()).code, 2);
  const failing = cli(['--repo', 'o/r', '--cap', '100'], () => { throw new Error('gh: not logged in'); }, new Date());
  assert.equal(failing.code, 2);
  assert.match(failing.err, /not logged in/);
});

test('CLI says when it hit the run cap', () => {
  const runs = [{ id: 1, status: 'completed' }, { id: 2, status: 'completed' }, { id: 3, status: 'completed' }];
  const r = cli(['--repo', 'o/r', '--cap', '2000', '--max-runs', '1'], fakeRunner(runs, { 1: [job(60)] }), new Date('2026-03-10T00:00:00Z'));
  assert.match(r.out, /Hit --max-runs 1/);
});
