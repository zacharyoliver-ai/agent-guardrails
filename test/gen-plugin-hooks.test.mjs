import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HOOKS } from '../lib/hook-table.mjs';
import { render } from '../bin/gen-plugin-hooks.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'bin', 'gen-plugin-hooks.mjs');
const json = (...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'));

test('hooks/hooks.json matches the hook table (generator --check exits 0)', () => {
  const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('every hook in the table appears in the generated file with a plugin-root path', () => {
  const { hooks } = JSON.parse(render());
  const commands = Object.values(hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  for (const h of HOOKS) {
    const want = h.on.length;
    const got = commands.filter((c) => c === `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${h.name}.mjs"`).length;
    assert.equal(got, want, h.name);
  }
});

test('the plugin and marketplace manifests parse and carry the package version', () => {
  const pkg = json('package.json');
  const plugin = json('.claude-plugin', 'plugin.json');
  const market = json('.claude-plugin', 'marketplace.json');
  assert.equal(plugin.name, 'agent-guardrails');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.description, pkg.description);
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
});

test('an unknown option exits 2 and the committed file equals the render', () => {
  const r = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  const have = fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8');
  assert.equal(have.replace(/\r\n/g, '\n'), render());
});

test('--check exits 1 on a stale file and 0 once the generator has rewritten it', () => {
  const dir = tmpDir('ag-genhooks-');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, 'hooks'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(script, path.join(dir, 'bin', 'gen-plugin-hooks.mjs'));
  for (const f of fs.readdirSync(path.join(root, 'lib'))) fs.copyFileSync(path.join(root, 'lib', f), path.join(dir, 'lib', f));
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  const copy = path.join(dir, 'bin', 'gen-plugin-hooks.mjs');
  assert.equal(spawnSync(process.execPath, [copy, '--check'], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [copy], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [copy, '--check'], { encoding: 'utf8' }).status, 0);
});
