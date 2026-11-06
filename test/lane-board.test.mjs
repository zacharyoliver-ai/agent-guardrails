import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { ageText, buildBoard, parseWorktrees } from '../bin/lane-board.mjs';

const script = fileURLToPath(new URL('../bin/lane-board.mjs', import.meta.url));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-lane-')));
  const root = path.join(base, 'main');
  fs.mkdirSync(root);
  try {
    git(root, 'init', '-b', 'main');
  } catch {
    git(root, 'init');
    git(root, 'checkout', '-b', 'main');
  }
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  const lane = (name, ...extra) => {
    const dir = path.join(base, name);
    git(root, 'worktree', 'add', ...(extra.length ? extra : ['-b', name]), dir, ...(extra.length ? [] : ['main']));
    return dir;
  };
  return { root, lane };
}

const commit = (dir, file, msg = 'change') => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '-m', msg);
};

test('no overlap: each lane lists its own files', () => {
  const { root, lane } = makeRepo();
  const one = lane('one');
  const two = lane('two');
  commit(one, 'a.txt');
  commit(two, 'sub/c.txt');
  const board = buildBoard(root);
  assert.equal(board.base, 'main');
  assert.deepEqual(board.overlaps, []);
  const byLabel = Object.fromEntries(board.lanes.map((l) => [l.label, l]));
  assert.deepEqual(byLabel.one.files, ['a.txt']);
  assert.deepEqual(byLabel.two.files, ['sub/c.txt']);
  assert.equal(byLabel.one.ahead, 1);
  assert.equal(byLabel.one.behind, 0);
  assert.equal(spawnSync(process.execPath, [script, '--root', root, '--strict'], { encoding: 'utf8' }).status, 0);
});

test('overlap: a committed file and a modified file in two lanes', () => {
  const { root, lane } = makeRepo();
  const one = lane('one');
  const two = lane('two');
  commit(one, 'a.txt');
  fs.writeFileSync(path.join(two, 'a.txt'), 'edited, not staged\n');
  const board = buildBoard(root);
  assert.deepEqual(board.overlaps, [{ file: 'a.txt', lanes: ['one', 'two'] }]);
  const loose = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(loose.status, 0);
  assert.match(loose.stdout, /a\.txt: one, two/);
  assert.equal(spawnSync(process.execPath, [script, '--root', root, '--strict'], { encoding: 'utf8' }).status, 1);
});

test('overlap: an untracked file and a staged file count', () => {
  const { root, lane } = makeRepo();
  const one = lane('one');
  const two = lane('two');
  fs.writeFileSync(path.join(one, 'new.txt'), 'x\n');
  fs.writeFileSync(path.join(two, 'new.txt'), 'y\n');
  fs.writeFileSync(path.join(two, 'b.txt'), 'staged\n');
  git(two, 'add', 'b.txt');
  const board = buildBoard(root);
  assert.deepEqual(board.overlaps, [{ file: 'new.txt', lanes: ['one', 'two'] }]);
  assert.ok(board.lanes.find((l) => l.label === 'two').files.includes('b.txt'));
});

test('a lane with a detached HEAD is listed and can overlap', () => {
  const { root, lane } = makeRepo();
  const one = lane('one');
  const det = lane('det', '--detach');
  commit(one, 'a.txt');
  commit(det, 'a.txt', 'other');
  const board = buildBoard(root);
  const d = board.lanes.find((l) => l.label === 'det');
  assert.match(d.branch, /^\(detached [0-9a-f]{7}\)$/);
  assert.deepEqual(board.overlaps, [{ file: 'a.txt', lanes: ['det', 'one'] }]);
});

test('a squash-merged lane no longer counts as editing its files', () => {
  const { root, lane } = makeRepo();
  const one = lane('one');
  const two = lane('two');
  commit(one, 'a.txt');
  git(root, 'merge', '--squash', 'one');
  git(root, 'commit', '-m', 'squash one');
  fs.writeFileSync(path.join(two, 'a.txt'), 'a new edit\n');
  const board = buildBoard(root);
  assert.deepEqual(board.lanes.find((l) => l.label === 'one').files, []);
  assert.deepEqual(board.overlaps, []);
});

test('a lane behind base reports the count', () => {
  const { root, lane } = makeRepo();
  const one = lane('one');
  commit(root, 'z.txt');
  assert.equal(buildBoard(root).lanes.find((l) => l.label === 'one').behind, 1);
  void one;
});

test('paths use forward slashes; parseWorktrees skips bare entries; ageText', () => {
  const wts = parseWorktrees('worktree C:\\x\\y\nHEAD abc\nbranch refs/heads/f\n\nworktree /bare\nbare\n');
  assert.deepEqual(wts, [{ path: 'C:/x/y', head: 'abc', branch: 'f' }]);
  assert.equal(ageText(90), '1m');
  assert.equal(ageText(7200), '2h');
  assert.equal(ageText(3 * 86400), '3d');
});

test('not a repository is a usage error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-lane-none-'));
  const r = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8', env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  assert.equal(r.status, 2);
});
