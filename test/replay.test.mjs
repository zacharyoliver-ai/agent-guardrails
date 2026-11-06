import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../bin/replay.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-replay-'));

const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const line = (blocks, cwd = os.tmpdir()) =>
  JSON.stringify({ type: 'assistant', cwd, sessionId: 's1', message: { id: 'm', role: 'assistant', content: blocks } });

function write(root, rel, lines, ageDays = 0) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (ageDays) {
    const t = new Date(Date.now() - ageDays * 86400e3);
    fs.utimesSync(file, t, t);
  }
  return file;
}

function run(args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const denied = (json, name) => json.guards[name].denied;

test('counts a denied git add -A and ignores an allowed git status', () => {
  const root = tmp();
  write(root, 'p/a.jsonl', [
    line([use('t1', 'Bash', { command: 'git add -A' })]),
    line([use('t2', 'Bash', { command: 'git status' })]),
  ]);
  const r = run(['--dir', root, '--json']);
  assert.equal(r.status, 0);
  const json = JSON.parse(r.out);
  assert.equal(json.sessions, 1);
  assert.equal(json.toolCalls, 2);
  assert.equal(denied(json, 'git-guard'), 1);
});

test('counts a repeated tool_use id once', () => {
  const root = tmp();
  const same = line([use('dup', 'Bash', { command: 'git add -A' })]);
  write(root, 'p/a.jsonl', [same, same]);
  const json = JSON.parse(run(['--dir', root, '--json']).out);
  assert.equal(json.toolCalls, 1);
  assert.equal(denied(json, 'git-guard'), 1);
});

test('counts damaged lines and keeps reading', () => {
  const root = tmp();
  write(root, 'p/a.jsonl', ['{not json', line([use('t1', 'Bash', { command: 'git add -A' })])]);
  const json = JSON.parse(run(['--dir', root, '--json']).out);
  assert.equal(json.damaged, 1);
  assert.equal(denied(json, 'git-guard'), 1);
});

test('a Task call with no model is denied by model-ladder', () => {
  const root = tmp();
  write(root, 'p/a.jsonl', [line([use('t1', 'Task', { description: 'find the config', prompt: 'x' })])]);
  const json = JSON.parse(run(['--dir', root, '--json']).out);
  assert.equal(denied(json, 'model-ladder'), 1);
});

test('--since skips a file last changed before the cutoff', () => {
  const root = tmp();
  write(root, 'p/old.jsonl', [line([use('t1', 'Bash', { command: 'git add -A' })])], 30);
  write(root, 'p/new.jsonl', [line([use('t2', 'Bash', { command: 'git add -A' })])]);
  const json = JSON.parse(run(['--dir', root, '--since', '7d', '--json']).out);
  assert.equal(json.sessions, 1);
  assert.equal(denied(json, 'git-guard'), 1);
});

test('text output lists guards sorted by count and nothing else', () => {
  const root = tmp();
  write(root, 'p/a.jsonl', [
    line([use('t1', 'Bash', { command: 'git add -A' })]),
    line([use('t2', 'Bash', { command: 'git add .' })]),
    line([use('t3', 'Task', { description: 'find x', prompt: 'x' })]),
  ]);
  const r = run(['--dir', root]);
  const rows = r.out.split(/\r?\n/).filter((l) => /would have denied/.test(l));
  assert.match(rows[0], /^git-guard\s+would have denied 2$/);
  assert.match(rows[1], /^model-ladder\s+would have denied 1$/);
  assert.equal(rows.length, 5);
  assert.doesNotMatch(r.out, /git add/);
});

test('--show masks a credential built at runtime', () => {
  const root = tmp();
  const key = 'ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5';
  write(root, 'p/a.jsonl', [line([use('t1', 'Bash', { command: `cat .env # ${key}` })])]);
  const r = run(['--dir', root, '--show']);
  assert.match(r.out, /secret-guard\s+would have denied 1/);
  assert.match(r.out, /\[masked\]/);
  assert.ok(!r.out.includes(key));
  assert.ok(!r.out.includes(key.slice(0, 12)));
});

test('--show limits each guard to five examples and 80 characters of command', () => {
  const root = tmp();
  const lines = [];
  for (let i = 0; i < 8; i++) lines.push(line([use(`t${i}`, 'Bash', { command: `git reset --hard ${'x'.repeat(200)}${i}` })]));
  write(root, 'p/a.jsonl', lines);
  const json = JSON.parse(run(['--dir', root, '--json', '--show']).out);
  assert.equal(denied(json, 'git-guard'), 8);
  assert.equal(json.guards['git-guard'].examples.length, 5);
  assert.ok(json.guards['git-guard'].examples[0].length < 200);
});

test('usage errors exit 2', () => {
  assert.equal(run(['--since', 'soon']).status, 2);
  assert.equal(run(['--dir', path.join(tmp(), 'missing')]).status, 2);
  assert.equal(run(['--bogus']).status, 2);
});
