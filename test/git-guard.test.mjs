import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check } from '../hooks/git-guard.mjs';

const script = fileURLToPath(new URL('../hooks/git-guard.mjs', import.meta.url));
const bash = (command, cwd) => ({ tool_name: 'Bash', cwd, tool_input: { command } });
const verdict = (command, env = {}, cwd) => check(bash(command, cwd), env);

test('sweeping adds are denied', () => {
  for (const c of ['git add -A', 'git add --all', 'git add .', 'git add -Av', 'git add -- .', 'git -C some/dir add -A', 'FOO=1 git add -A', 'cd x && git add .', 'sudo git add -A', 'bash -c "git add -A"']) {
    assert.match(verdict(c), /Name the paths/, c);
  }
});

test('named adds and commits pass', () => {
  for (const c of ['git add src/a.js', 'git add -p src/a.js', 'git commit -m x -- src/a.js', 'git commit -m "msg" -- a b', 'git commit --amend --no-edit', 'git status', 'git log --all', 'git commit -m "-a"']) {
    assert.equal(verdict(c), null, c);
  }
});

test('quoted text never triggers', () => {
  for (const c of ['git commit -m "never use git add -A" -- f', 'echo "git push --force origin main"', "echo 'git reset --hard'", 'git commit -m "rm -rf / is bad" -- f', 'cat <<EOF\ngit add -A\nEOF']) {
    assert.equal(verdict(c), null, c);
  }
});

test('commit -a variants are denied', () => {
  for (const c of ['git commit -a -m x', 'git commit -am x', 'git commit --all -m x', 'git commit -sam x']) {
    assert.match(verdict(c), /commit -a/, c);
  }
});

test('force pushes are denied, lease is allowed', () => {
  for (const c of ['git push --force', 'git push -f origin feature', 'git push origin +feature', 'git push -uf origin feature']) {
    assert.match(verdict(c), /forced push/, c);
  }
  assert.equal(verdict('git push --force-with-lease origin feature'), null);
  assert.equal(verdict('git push -u origin feature'), null);
  assert.equal(verdict('git push'), null);
});

test('pushes that target main or master are denied unless allowed', () => {
  for (const c of ['git push origin main', 'git push origin master', 'git push origin HEAD:main', 'git push -u origin feature:refs/heads/main', 'git push origin :main']) {
    assert.match(verdict(c), /main or master/, c);
  }
  assert.equal(verdict('git push origin main', { GUARDRAILS_GIT_ALLOW_MAIN: '1' }), null);
  assert.match(verdict('git push -f origin main', { GUARDRAILS_GIT_ALLOW_MAIN: '1' }), /forced push/);
  assert.equal(verdict('git push origin main-fix'), null);
  assert.equal(verdict('git push origin maintenance'), null);
});

test('reset --hard, clean -f, discard-all and bare stash are denied', () => {
  for (const c of ['git reset --hard', 'git reset --hard HEAD~1', 'git clean -f', 'git clean -fd', 'git clean --force', 'git checkout -- .', 'git checkout .', 'git restore .', 'git stash', 'git stash push', 'git stash push -m x', 'git stash -u']) {
    assert.notEqual(verdict(c), null, c);
  }
});

test('harmless relatives of those commands pass', () => {
  for (const c of ['git reset --soft HEAD~1', 'git reset src/a.js', 'git clean -n', 'git checkout feature', 'git checkout -- src/a.js', 'git restore src/a.js', 'git restore --staged .', 'git stash list', 'git stash show -p', 'git stash pop', 'git stash apply']) {
    assert.equal(verdict(c), null, c);
  }
});

test('worktree remove is denied while node_modules is a link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wt-'));
  const shared = path.join(root, 'shared');
  const linked = path.join(root, 'linked');
  const plain = path.join(root, 'plain');
  for (const d of [shared, linked, plain, path.join(plain, 'node_modules')]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(shared, path.join(linked, 'node_modules'), 'junction');
  const reason = verdict('git worktree remove linked', {}, root);
  assert.match(reason, /remove the link first|Remove the link first/);
  assert.match(verdict(`git worktree remove --force ${linked.replace(/\\/g, '/')}`, {}, os.tmpdir()), /shared/);
  assert.equal(verdict('git worktree remove plain', {}, root), null);
  assert.equal(verdict('git worktree remove missing', {}, root), null);
  assert.equal(verdict('git worktree list', {}, root), null);
  assert.ok(fs.existsSync(shared));
});

test('rm -rf aimed at the root, home or everything is denied', () => {
  for (const c of ['rm -rf /', 'rm -rf ~', 'rm -rf $HOME', 'rm -rf "$HOME"', 'rm -rf .', 'rm -rf *', 'rm -fr /*', 'rm -r ./', 'rm -rf ~/', 'rm -rf build /']) {
    assert.match(verdict(c), /rm -r/, c);
  }
  for (const c of ['rm -rf build', 'rm -rf node_modules', 'rm file.txt', 'rm -f *.log', 'rm -rf ./build', 'echo rm -rf /']) {
    assert.equal(verdict(c), null, c);
  }
});

test('other tools and missing commands are ignored', () => {
  assert.equal(check({ tool_name: 'Write', tool_input: { command: 'git add -A' } }, {}), null);
  assert.equal(check({ tool_name: 'Bash', tool_input: {} }, {}), null);
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('script: prints a deny decision', () => {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(bash('git add -A')), encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
