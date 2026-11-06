import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mergeHooks } from '../bin/setup.mjs';
import { HOOKS, buildHooks } from '../lib/hook-table.mjs';

const script = fileURLToPath(new URL('../bin/setup.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-setup-'));
const settingsPath = (dir) => path.join(dir, '.claude', 'settings.json');
const setup = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const read = (dir) => JSON.parse(fs.readFileSync(settingsPath(dir), 'utf8'));
const withFile = (dir, text) => {
  fs.mkdirSync(path.dirname(settingsPath(dir)), { recursive: true });
  fs.writeFileSync(settingsPath(dir), text);
};

test('creates the settings file with every hook under its own event and matcher', () => {
  const dir = project();
  const r = setup('--project', dir);
  assert.equal(r.status, 0);
  const hooks = read(dir).hooks;
  const find = (event, name) => hooks[event].find((g) => g.hooks[0].command.includes(`/hooks/${name}.mjs`));
  assert.equal(find('PreToolUse', 'git-guard').matcher, 'Bash|PowerShell');
  assert.equal(find('PreToolUse', 'step-budget').matcher, '*');
  assert.ok(find('Stop', 'never-say'));
  assert.ok(find('SubagentStart', 'fleet-cap'));
  assert.ok(find('SubagentStop', 'fleet-cap'));
  assert.ok(find('UserPromptSubmit', 'decisions-file'));
  assert.match(find('PreToolUse', 'git-guard').hooks[0].command, new RegExp(`node "${root.replace(/\\/g, '/').replace(/\/$/, '')}/hooks/git-guard.mjs"`));
  assert.match(r.stdout, /added git-guard \(PreToolUse Bash\|PowerShell\)/);
});

test('running twice adds nothing the second time', () => {
  const dir = project();
  setup('--project', dir);
  const once = fs.readFileSync(settingsPath(dir), 'utf8');
  const r = setup('--project', dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Nothing to add/);
  assert.equal(fs.readFileSync(settingsPath(dir), 'utf8'), once);
});

test('keeps every existing setting and hook', () => {
  const dir = project();
  const mine = { type: 'command', command: 'echo mine' };
  withFile(dir, JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }], Notification: [{ hooks: [mine] }] } }));
  assert.equal(setup('--project', dir, '--only', 'git-guard').status, 0);
  const s = read(dir);
  assert.equal(s.model, 'x');
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(s.hooks.Notification, [{ hooks: [mine] }]);
  assert.deepEqual(s.hooks.PreToolUse[0].hooks, [mine]);
  assert.equal(s.hooks.PreToolUse.length, 2);
});

test('--only adds just the named hooks, and an unknown name exits 2 without writing', () => {
  const dir = project();
  assert.equal(setup('--project', dir, '--only', 'git-guard,secret-guard').status, 0);
  assert.equal(read(dir).hooks.PreToolUse.length, 2);
  assert.equal(read(dir).hooks.Stop, undefined);
  const other = project();
  const r = setup('--project', other, '--only', 'git-guard,nope');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown hook: nope/);
  assert.equal(fs.existsSync(settingsPath(other)), false);
});

test('--dry-run prints what it would add and writes nothing', () => {
  const dir = project();
  const r = setup('--project', dir, '--dry-run');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /would add step-budget/);
  assert.equal(fs.existsSync(settingsPath(dir)), false);
});

test('a damaged settings file exits 2 and is left untouched', () => {
  for (const text of ['{not json', '[1]', JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { Stop: 'x' } })]) {
    const dir = project();
    withFile(dir, text);
    const r = setup('--project', dir);
    assert.equal(r.status, 2, text);
    assert.match(r.stderr, /damaged/);
    assert.equal(fs.readFileSync(settingsPath(dir), 'utf8'), text);
  }
});

test('missing or absent --project exits 2', () => {
  assert.equal(setup().status, 2);
  assert.equal(setup('--project', path.join(os.tmpdir(), 'ag-no-such-folder-xyz')).status, 2);
});

test('mergeHooks does not change its input', () => {
  const input = { hooks: { Stop: [] } };
  const { settings, added } = mergeHooks(input, ['never-say'], '/x');
  assert.deepEqual(input, { hooks: { Stop: [] } });
  assert.equal(settings.hooks.Stop.length, 1);
  assert.deepEqual(added, ['never-say (Stop)']);
});

test('every hook file has a table row, and every row has a hook file', () => {
  const files = fs.readdirSync(path.join(root, 'hooks')).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, '')).sort();
  assert.deepEqual(HOOKS.map((h) => h.name).sort(), files);
});

test('examples/settings.json is generated from the same table', () => {
  const example = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'settings.json'), 'utf8'));
  assert.deepEqual(example, { hooks: buildHooks('$CLAUDE_PROJECT_DIR') });
});
