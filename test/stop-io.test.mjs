import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { finalText, turnLines, sendBack, addContext } from '../lib/stop-io.mjs';

function writeTranscript(lines, raw = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sio-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, [...lines.map((l) => JSON.stringify(l)), ...raw].join('\n') + '\n');
  return file;
}
const person = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const result = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const asst = (id, ...content) => ({ type: 'assistant', message: { id, role: 'assistant', content } });
const text = (t) => ({ type: 'text', text: t });
const tool = (name, input) => ({ type: 'tool_use', name, input });

test('finalText prefers last_assistant_message', () => {
  assert.equal(finalText({ last_assistant_message: 'hi', transcript_path: '/nope' }), 'hi');
});

test('finalText joins text blocks that share the last message id', () => {
  const file = writeTranscript([
    asst('m1', text('old')),
    asst('m2', text('first part')),
    asst('m2', tool('Bash', {})),
    asst('m2', text('second part')),
  ]);
  assert.equal(finalText({ transcript_path: file }), 'first part\nsecond part');
});

test('finalText skips damaged lines and tolerates a missing file', () => {
  const file = writeTranscript([asst('m1', text('fine'))], ['{broken']);
  assert.equal(finalText({ transcript_path: file }), 'fine');
  assert.equal(finalText({ transcript_path: path.join(os.tmpdir(), 'ag-missing.jsonl') }), '');
  assert.equal(finalText({}), '');
});

test('turnLines starts after the last person message, not after a tool result', () => {
  const file = writeTranscript([
    person('first'),
    asst('a', text('x')),
    person('second'),
    asst('b', tool('Edit', {})),
    result(),
    asst('c', text('done')),
  ]);
  const lines = turnLines({ transcript_path: file });
  assert.equal(lines.length, 3);
  assert.equal(lines[0].message.id, 'b');
});

test('turnLines treats a text-block user message as a person message', () => {
  const file = writeTranscript([
    asst('a', text('x')),
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    asst('b', text('y')),
  ]);
  assert.equal(turnLines({ transcript_path: file }).length, 1);
});

test('turnLines returns everything when no person message exists, and [] without a file', () => {
  const file = writeTranscript([asst('a', text('x'))]);
  assert.equal(turnLines({ transcript_path: file }).length, 1);
  assert.deepEqual(turnLines({}), []);
});

test('sendBack and addContext print the documented JSON', () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => (chunks.push(String(c)), true);
  try {
    sendBack('why');
    addContext('ctx');
  } finally {
    process.stdout.write = orig;
  }
  assert.deepEqual(JSON.parse(chunks[0]), { decision: 'block', reason: 'why' });
  assert.deepEqual(JSON.parse(chunks[1]), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'ctx' } });
});

const probe = `
import { runStop } from ${JSON.stringify(new URL('../lib/stop-io.mjs', import.meta.url).href)};
await runStop('probe', (i) => (i.boom ? (() => { throw new Error('bad'); })() : 'sent back'));
`;
function runProbe(input) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-probe-')), 'probe.mjs');
  fs.writeFileSync(file, probe);
  return spawnSync(process.execPath, [file], { input, encoding: 'utf8' });
}

test('runStop sends back, allows on stop_hook_active, and fails open', () => {
  const back = runProbe(JSON.stringify({ hook_event_name: 'Stop' }));
  assert.equal(JSON.parse(back.stdout).decision, 'block');
  assert.equal(runProbe(JSON.stringify({ stop_hook_active: true })).stdout, '');
  const thrown = runProbe(JSON.stringify({ boom: true }));
  assert.equal(thrown.stdout, '');
  assert.equal(thrown.stderr.trim().split('\n').length, 1);
  const bad = runProbe('not json');
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr.trim().split('\n').length, 1);
});
