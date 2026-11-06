import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkSeat } from '../hooks/design-seat.mjs';

const script = fileURLToPath(new URL('../hooks/design-seat.mjs', import.meta.url));
const seat = { GUARDRAILS_SEAT: 'design' };
const edit = (file_path, tool_name = 'Edit') => ({ tool_name, tool_input: { file_path } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('inactive without the seat variable', () => {
  assert.equal(checkSeat(edit('api/users.js'), {}), null);
  assert.equal(checkSeat(bash('git push origin main'), {}), null);
});

test('screen files pass', () => {
  for (const f of ['src/ui/Button.css', 'src/screens/Home.jsx', 'docs/readme.md', 'src/latest.js', 'src/rapi/Card.css', 'src/contest/Banner.jsx']) {
    assert.equal(checkSeat(edit(f), seat), null, f);
  }
});

test('backend and test paths are denied for Edit and Write', () => {
  const paths = ['api/x.js', 'src/server/x.js', 'db/schema.sql', 'migrations/001.sql', 'scripts/build.mjs', 'test/a.js', 'tests/a.js', 'src/Home.test.jsx', 'src/Home.spec.ts', 'C:\\proj\\api\\x.js'];
  for (const f of paths) {
    for (const t of ['Edit', 'Write']) assert.match(checkSeat(edit(f, t), seat), /screens only/, `${t} ${f}`);
  }
});

test('push, pull requests and test runs are denied in Bash', () => {
  for (const c of ['git push', 'git  push origin x', 'gh pr create', 'npm test', 'npm run test', 'node --test test/', 'npx playwright test']) {
    assert.match(checkSeat(bash(c), seat), /does not push/, c);
  }
});

test('other Bash commands pass', () => {
  for (const c of ['git status', 'git commit -m x', 'npm run build', 'ls']) assert.equal(checkSeat(bash(c), seat), null, c);
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = spawnSync(process.execPath, [script], { input: '', encoding: 'utf8', env: { ...process.env, ...seat } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('script: end to end deny and allow', () => {
  const run = (input) => spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...seat } });
  const denied = run(bash('git push'));
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run(edit('src/ui/a.css')).stdout, '');
});
