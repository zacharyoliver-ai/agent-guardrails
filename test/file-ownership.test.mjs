import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkOwnership, relativeToCwd } from '../hooks/file-ownership.mjs';
import { matchGlob } from '../lib/hook-io.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const script = fileURLToPath(new URL('../hooks/file-ownership.mjs', import.meta.url));
const owners = { lanes: { api: ['src/api/**', 'test/api/**'], web: ['src/web/**', '*.css'] } };

function project() {
  const dir = tmpDir('ag-own-');
  fs.mkdirSync(path.join(dir, '.guardrails'));
  fs.writeFileSync(path.join(dir, '.guardrails', 'owners.json'), JSON.stringify(owners));
  return dir;
}
const edit = (cwd, file_path, tool_name = 'Edit') => ({ cwd, tool_name, tool_input: { file_path } });
const api = { GUARDRAILS_LANE: 'api' };

test('glob: * stays in a segment, ** crosses them', () => {
  assert.ok(matchGlob('src/api/**', 'src/api/a/b/c.js'));
  assert.ok(matchGlob('src/*/x.js', 'src/api/x.js'));
  assert.ok(!matchGlob('src/*/x.js', 'src/api/deep/x.js'));
  assert.ok(matchGlob('**/x.js', 'x.js'));
  assert.ok(!matchGlob('src/api/**', 'src/apix/a.js'));
  assert.ok(!matchGlob('a.js', 'aXjs'));
});

test('allows a path inside the lane', () => {
  const cwd = project();
  assert.equal(checkOwnership(edit(cwd, 'src/api/users.js'), api), null);
});

test('denies a path outside the lane, for each edit tool', () => {
  const cwd = project();
  for (const t of ['Edit', 'Write']) assert.match(checkOwnership(edit(cwd, 'src/web/app.js', t), api), /does not own src\/web\/app\.js/);
  const nb = { cwd, tool_name: 'NotebookEdit', tool_input: { notebook_path: 'src/web/n.ipynb' } };
  assert.match(checkOwnership(nb, api), /does not own/);
});

test('other tools, no lane and no owners file all allow', () => {
  const cwd = project();
  assert.equal(checkOwnership({ cwd, tool_name: 'Read', tool_input: { file_path: 'src/web/a.js' } }, api), null);
  assert.equal(checkOwnership(edit(cwd, 'src/web/a.js'), {}), null);
  const bare = tmpDir('ag-bare-');
  assert.equal(checkOwnership(edit(bare, 'src/web/a.js'), api), null);
});

test('rejects .. escapes', () => {
  const cwd = project();
  assert.match(checkOwnership(edit(cwd, 'src/api/../web/app.js'), api), /does not own src\/web\/app\.js/);
  assert.match(checkOwnership(edit(cwd, '../outside.js'), api), /outside the project/);
  assert.match(checkOwnership(edit(cwd, 'src/api/../../../x.js'), api), /outside the project/);
});

test('normalizes Windows backslashes', () => {
  const cwd = project();
  assert.equal(checkOwnership(edit(cwd, 'src\\api\\users.js'), api), null);
  assert.match(checkOwnership(edit(cwd, 'src\\web\\app.js'), api), /does not own/);
  const winCwd = String.raw`C:\work\proj`;
  assert.equal(relativeToCwd(String.raw`C:\work\proj\src\api\a.js`, winCwd), 'src/api/a.js');
  assert.equal(relativeToCwd('c:/WORK/proj/x.js', winCwd), 'x.js');
  assert.equal(relativeToCwd(String.raw`D:\other\x.js`, winCwd), null);
});

test('absolute paths inside and outside the lane', () => {
  const cwd = project();
  assert.equal(checkOwnership(edit(cwd, path.join(cwd, 'src', 'api', 'a.js')), api), null);
  assert.match(checkOwnership(edit(cwd, path.join(cwd, 'src', 'web', 'a.js')), api), /does not own/);
  assert.match(checkOwnership(edit(cwd, path.join(os.tmpdir(), 'elsewhere.js')), api), /outside the project/);
});

test('an undefined lane owns nothing', () => {
  const cwd = project();
  assert.match(checkOwnership(edit(cwd, 'src/api/a.js'), { GUARDRAILS_LANE: 'typo' }), /not defined/);
});

test('script: malformed stdin and a damaged owners file both allow', () => {
  const bad = spawnSync(process.execPath, [script], { input: '{{', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr.trim().split('\n').length, 1);

  const cwd = project();
  fs.writeFileSync(path.join(cwd, '.guardrails', 'owners.json'), 'oops');
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(edit(cwd, 'src/web/a.js')),
    encoding: 'utf8',
    env: { ...process.env, GUARDRAILS_LANE: 'api' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('script: end to end deny and allow', () => {
  const cwd = project();
  const run = (file) =>
    spawnSync(process.execPath, [script], {
      input: JSON.stringify(edit(cwd, file)),
      encoding: 'utf8',
      env: { ...process.env, GUARDRAILS_LANE: 'api' },
    });
  const denied = JSON.parse(run('src/web/app.js').stdout);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('src/api/app.js').stdout, '');
});
