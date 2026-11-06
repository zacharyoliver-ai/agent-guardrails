import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCENES, runScenes } from '../demo/run.mjs';

const script = fileURLToPath(new URL('../demo/run.mjs', import.meta.url));

test('the demo exits 0, shows deny and allow, catches the planted fault, writes the picture and cleans up', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-test-'));
  const svg = path.join(home, 'out', 'demo.svg');
  try {
    const env = { ...process.env, TMPDIR: home, TEMP: home, TMP: home };
    delete env.NO_COLOR;
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [script, '--svg', svg], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /tried: git add -A\r?\n\s+DENIED/);
    assert.match(r.stdout, /tried: git add src\/app\.js\r?\n\s+allowed/);
    assert.match(r.stdout, /CAUGHT/);
    assert.ok(!r.stdout.includes('\x1b['), 'no colour codes when stdout is not a terminal');
    assert.ok(!r.stdout.includes('ERROR'));

    const picture = fs.readFileSync(svg, 'utf8');
    assert.match(picture, /^<svg /);
    assert.match(picture, /DENIED/);
    assert.match(picture, /allowed/);
    assert.ok(picture.split(/\r?\n/).length < 60);
    assert.ok(!/<image|@import|href=/.test(picture), 'no external images or fonts');

    const left = fs.readdirSync(home).filter((n) => n !== 'out');
    assert.deepEqual(left, [], 'the demo removes its temp folder');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('every guard has a deny scene and an allow scene', () => {
  const hooks = new Map();
  for (const s of SCENES) hooks.set(s.hook, (hooks.get(s.hook) || new Set()).add(s.expect));
  for (const [hook, set] of hooks) assert.ok(set.has('allowed') && set.size >= 2, `${hook} needs both an allow and a deny scene`);
  assert.ok(hooks.size >= 13);
});

test('a scene whose result differs from its expectation is reported as not ok', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-test-'));
  try {
    const gitScenes = SCENES.filter((s) => s.hook === 'git-guard');
    const wrong = gitScenes.map((s) => ({ ...s, expect: s.expect === 'DENIED' ? 'allowed' : 'DENIED' }));
    assert.ok(runScenes(gitScenes, home).every((r) => r.ok));
    assert.ok(runScenes(wrong, home).every((r) => !r.ok));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
