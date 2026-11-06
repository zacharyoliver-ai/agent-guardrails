import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkProof } from '../hooks/proof-required.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const script = fileURLToPath(new URL('../hooks/proof-required.mjs', import.meta.url));
let n = 0;
const asst = (...content) => ({ type: 'assistant', message: { id: `m${n++}`, role: 'assistant', content } });
const tool = (name, input) => asst({ type: 'tool_use', name, input });
const edit = (file = 'src/a.js') => tool('Edit', { file_path: file });
const bash = (command) => tool('Bash', { command });
const person = { type: 'user', message: { role: 'user', content: 'please fix it' } };
const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } };

function input(lines, finalMessage) {
  const dir = tmpDir('ag-pr-');
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { transcript_path: file, last_assistant_message: finalMessage, cwd: dir };
}

test('allows a completion claim when a check ran after the last edit', () => {
  assert.equal(checkProof(input([person, edit(), result, bash('npm test'), result], 'Fixed, tests pass.')), null);
});

test('sends back a completion claim with no check, naming the file', () => {
  const r = checkProof(input([person, edit('src/widget.js'), result], 'All done.'));
  assert.match(r, /src\/widget\.js/);
  assert.match(r, /not verified/);
});

test('a check that ran before the edit does not count', () => {
  assert.ok(checkProof(input([person, bash('node --test'), result, edit(), result], 'Fixed.')));
});

test('only the last edit matters: an edit after the check sends back', () => {
  assert.ok(checkProof(input([person, edit(), bash('npx eslint .'), edit('b.js')], 'Complete.')));
});

test('no edit in the turn allows, even after an edit in an earlier turn', () => {
  const earlier = [edit(), person, bash('ls'), result];
  assert.equal(checkProof(input(earlier, 'Finished looking, nothing changed; it is done.')), null);
});

test('a message that makes no completion claim allows', () => {
  assert.equal(checkProof(input([person, edit()], 'I changed the file and will look at it next.')), null);
});

test('an honest statement that nothing ran allows', () => {
  for (const t of ['Done, but not verified.', 'Fixed. Unverified.', 'Done; I did not run the tests.', "Done, I didn't run anything."]) {
    assert.equal(checkProof(input([person, edit()], t)), null, t);
  }
});

test('a Bash command that is not a check does not count; Write and NotebookEdit are edits', () => {
  assert.ok(checkProof(input([person, edit(), bash('ls -la')], 'Done.')));
  assert.ok(checkProof(input([person, tool('Write', { file_path: 'x.md' })], 'Done.')));
  assert.ok(checkProof(input([person, tool('NotebookEdit', { notebook_path: 'n.ipynb' })], 'Done.')));
});

test('GUARDRAILS_PROOF_COMMANDS replaces the default pattern', () => {
  const lines = [person, edit(), bash('make verify')];
  assert.ok(checkProof(input(lines, 'Done.'), {}));
  assert.equal(checkProof(input(lines, 'Done.'), { GUARDRAILS_PROOF_COMMANDS: '\\bmake verify\\b' }), null);
  assert.ok(checkProof(input([person, edit(), bash('npm test')], 'Done.'), { GUARDRAILS_PROOF_COMMANDS: '\\bmake verify\\b' }));
});

test('script: sends back, allows on stop_hook_active, fails open on bad input', () => {
  const i = input([person, edit()], 'Done.');
  const run = (stdin) => spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8' });
  assert.equal(JSON.parse(run(JSON.stringify(i)).stdout).decision, 'block');
  assert.equal(run(JSON.stringify({ ...i, stop_hook_active: true })).stdout, '');
  const bad = run('not json');
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr.trim().split('\n').length, 1);
});
