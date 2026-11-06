import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildReport, formatReport, parseSince, scanFile } from '../bin/usage-report.mjs';

const script = fileURLToPath(new URL('../bin/usage-report.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-usage-'));

const line = (id, usage, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    requestId: `req-${id}`,
    timestamp: extra.timestamp || new Date().toISOString(),
    message: {
      id: `msg-${id}`,
      model: extra.model || 'model-a',
      usage: {
        input_tokens: usage[0],
        output_tokens: usage[1],
        cache_read_input_tokens: usage[2] || 0,
        cache_creation_input_tokens: usage[3] || 0,
      },
    },
  });

function write(root, rel, lines) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('counts a repeated message id once and keeps the largest usage', async () => {
  const root = tmp();
  const file = write(root, 'proj/aaaaaaaa-1111.jsonl', [
    line('1', [10, 5]),
    line('1', [10, 40]),
    line('2', [20, 7, 100, 50]),
  ]);
  const row = await scanFile(file);
  assert.equal(row.requests, 2);
  assert.equal(row.input, 30);
  assert.equal(row.output, 47);
  assert.equal(row.cacheRead, 100);
  assert.equal(row.cacheWrite, 50);
  assert.equal(row.peak, 170);
});

test('skips placeholder lines that never reached a model', async () => {
  const root = tmp();
  const file = write(root, 'proj/bbbbbbbb-2222.jsonl', [
    line('1', [10, 5]),
    line('2', [0, 0], { model: '<synthetic>' }),
  ]);
  const row = await scanFile(file);
  assert.equal(row.requests, 1);
  assert.deepEqual(row.models, ['model-a']);
});

test('falls back to requestId when message.id is missing', async () => {
  const root = tmp();
  const a = JSON.parse(line('1', [1, 1]));
  delete a.message.id;
  const file = write(root, 'p/x.jsonl', [JSON.stringify(a), JSON.stringify(a)]);
  assert.equal((await scanFile(file)).requests, 1);
});

test('skips damaged lines and counts them', async () => {
  const root = tmp();
  write(root, 'p/s.jsonl', [line('1', [1, 1]), '{not json', line('2', [1, 1])]);
  const report = await buildReport({ dir: root });
  assert.equal(report.damaged, 1);
  assert.equal(report.rows[0].requests, 2);
});

test('labels subagent transcripts as agent and others as session', async () => {
  const root = tmp();
  write(root, 'proj/sess1234.jsonl', [line('1', [1, 1])]);
  write(root, 'proj/sess1234/subagents/agent-abcd9999.jsonl', [line('2', [1, 1])]);
  const report = await buildReport({ dir: root });
  const kinds = Object.fromEntries(report.rows.map((r) => [r.id, r.kind]));
  assert.deepEqual(kinds, { sess1234: 'session', abcd9999: 'agent' });
  assert.equal(report.rows[0].project, 'proj');
});

test('flags runaways by request count and by peak context', async () => {
  const root = tmp();
  write(root, 'p/many.jsonl', [line('1', [1, 1]), line('2', [1, 1]), line('3', [1, 1])]);
  write(root, 'p/big.jsonl', [line('1', [100, 1, 300, 0])]);
  write(root, 'p/small.jsonl', [line('1', [1, 1])]);
  const report = await buildReport({ dir: root, maxRequests: 2, maxContext: 399 });
  const flagged = report.rows.filter((r) => r.runaway).map((r) => r.id).sort();
  assert.deepEqual(flagged, ['big', 'many']);
  assert.equal(report.runaways, 2);
  const text = formatReport(report);
  assert.match(text, /RUNAWAY/);
  assert.match(text, /Runaways: 2/);
});

test('--since skips old files by mtime and old lines by timestamp', async () => {
  const root = tmp();
  const old = write(root, 'p/old.jsonl', [line('1', [1, 1])]);
  const past = new Date(Date.now() - 10 * 86400e3);
  fs.utimesSync(old, past, past);
  write(root, 'p/mixed.jsonl', [
    line('1', [1, 1], { timestamp: past.toISOString() }),
    line('2', [1, 1]),
  ]);
  const report = await buildReport({ dir: root, sinceMs: parseSince('2d') });
  assert.deepEqual(report.rows.map((r) => r.id), ['mixed']);
  assert.equal(report.rows[0].requests, 1);
});

test('parseSince accepts hours, days and dates and rejects the rest', () => {
  const now = Date.parse('2026-03-10T12:00:00Z');
  assert.equal(parseSince('24h', now), now - 86400e3);
  assert.equal(parseSince('7d', now), now - 7 * 86400e3);
  assert.equal(parseSince('2026-03-01', now), Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(parseSince('soon', now), null);
});

test('totals per model and sorting by total tokens', async () => {
  const root = tmp();
  write(root, 'p/small.jsonl', [line('1', [1, 1], { model: 'model-a' })]);
  write(root, 'p/large.jsonl', [line('1', [500, 5], { model: 'model-b' })]);
  const report = await buildReport({ dir: root });
  assert.equal(report.rows[0].id, 'large');
  assert.equal(report.models['model-b'].input, 500);
  assert.equal(report.models['model-a'].requests, 1);
});

test('CLI exit codes: 0 clean, 1 runaway, 2 usage error; --json parses', () => {
  const root = tmp();
  write(root, 'p/s.jsonl', [line('1', [1, 1]), line('2', [1, 1])]);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(run('--dir', root).status, 0);
  const bad = run('--dir', root, '--max-requests', '1', '--json');
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).runaways, 1);
  assert.equal(run('--dir', root, '--since', 'whenever').status, 2);
  assert.equal(run('--dir', path.join(root, 'missing')).status, 2);
});
