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

test('git add with named paths is not a sweep', () => {
  for (const c of ['git add -A src/a.js', 'git add --all src tests', 'git add -A -- src/a.js', 'git add src/a.js', 'git add -u src/a.js']) {
    assert.equal(verdict(c), null, c);
  }
  for (const c of ['git add -A', 'git add --all', 'git add .', 'git add ./', 'git add -A .', 'git add -- .', 'git add :/', 'git add -A :/', "git add '*'", 'git add *', 'git add -u', 'git add --update', 'git add -uv']) {
    assert.match(verdict(c), /Name the paths/, c);
  }
});

test('git stash with named paths is not a sweep', () => {
  for (const c of ['git stash push src/a.js', 'git stash push -q -m note -- src/a.js tests/b.js', 'git stash -- src/a.js', 'git stash list', 'git stash show', 'git stash pop', 'git stash apply']) {
    assert.equal(verdict(c), null, c);
  }
  for (const c of ['git stash', 'git stash -q', 'git stash -u', 'git stash -m note', 'git stash push', 'git stash push -m note', 'git stash push -u -m note', 'git stash save note', 'git stash push -- .', 'git stash push .']) {
    assert.match(verdict(c), /git stash push -- path\/one/, c);
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
  assert.equal(verdict('git push', {}, repoOn('feature')), null);
});

// A temp repository whose checked-out branch is `branch` (no commit needed to read it).
function repoOn(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-gg-'));
  const run = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '-q');
  run('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  return dir;
}

test('a bare push or a push of HEAD is denied while main or master is checked out', () => {
  for (const branch of ['main', 'master']) {
    const cwd = repoOn(branch);
    for (const c of ['git push', 'git push origin', 'git push origin HEAD', 'git push -u origin HEAD', 'git -C . push', 'git push origin 2>&1 | tail -n 3', 'git push > out.txt']) {
      assert.match(verdict(c, {}, cwd), /main or master/, `${branch}: ${c}`);
    }
    assert.equal(verdict('git push origin feature', {}, cwd), null);
    assert.equal(verdict('git push --tags', {}, cwd), null);
    assert.equal(verdict('git push', { GUARDRAILS_GIT_ALLOW_MAIN: '1' }, cwd), null);
  }
  const feature = repoOn('feature');
  for (const c of ['git push', 'git push origin HEAD']) assert.equal(verdict(c, {}, feature), null, c);
});

test('an input redirection is not an argument, so it never hides a sweep or a bare push', () => {
  for (const c of ['git add -A </dev/null', 'git add -A < /dev/null', 'git add --all </dev/null', 'git stash </dev/null']) {
    assert.notEqual(verdict(c), null, c);
  }
  assert.match(verdict('git push origin </dev/null', {}, repoOn('main')), /main or master/);
  assert.equal(verdict('git add src/a.js </dev/null'), null);
});

test('a cd earlier in the command decides which branch a bare push reads', () => {
  const main = repoOn('main');
  const feature = repoOn('feature');
  assert.equal(verdict(`cd "${feature}" && git push -u origin HEAD`, {}, main), null);
  assert.match(verdict(`cd "${main}" && git push`, {}, feature), /main or master/);
  assert.equal(verdict('cd "$LANE" && git push', {}, main), null);
  assert.match(verdict('git push', {}, main), /main or master/);
});

test('a push where the branch cannot be read is allowed', () => {
  assert.equal(verdict('git push', {}, path.join(os.tmpdir(), 'ag-gg-no-such-folder')), null);
});

test('launchers, shells, keywords and program paths do not hide a denied command', () => {
  for (const c of [
    'env X=1 git add -A', 'env -i git add -A', 'sudo -u bob git add -A', 'sudo FOO=1 git add -A',
    'time -p git add -A', 'nice -n 5 git add -A', 'bash -lc "git add -A"', 'sh -xc "git add -A"',
    'eval "git add -A"', 'echo "$(git add -A)"', '/usr/bin/git add -A', 'git.exe add -A',
    'if true; then git add -A; fi', 'for f in a; do git reset --hard; done', '{ git add -A; }',
    '! git add -A', 'while true; do git add .; done', 'git --config-env x=Y add -A',
    'xargs -n1 git reset --hard', 'timeout 60 git add -A',
  ]) {
    assert.notEqual(verdict(c), null, c);
  }
  assert.match(verdict('/bin/rm -rf /'), /rm -r/);
  assert.match(verdict('sudo /usr/bin/rm -rf ~'), /rm -r/);
});

test('mentions inside strings and harmless launched commands stay allowed', () => {
  for (const c of [
    'git commit -m "git add -A is denied now" -- f', 'echo "git reset --hard"', 'env X=1 git status',
    'sudo -u bob git add src/a.js', 'bash -lc "git status"', 'xargs git add', 'echo "$(git status)"',
    'if true; then git status; fi', 'echo eval git add -A',
  ]) {
    assert.equal(verdict(c), null, c);
  }
});

test('git clean: dry runs pass, forced cleans are denied', () => {
  for (const c of ['git clean -nfd', 'git clean --dry-run -fd', 'git clean -fdn', 'git clean -n -f']) {
    assert.equal(verdict(c), null, c);
  }
  for (const c of ['git clean -fd', 'git clean -f', 'git clean --force -d']) assert.match(verdict(c), /clean -f/, c);
});

test('the PowerShell tool is checked like Bash', () => {
  const ps = (command) => check({ tool_name: 'PowerShell', tool_input: { command } }, {});
  assert.match(ps('git add -A'), /Name the paths/);
  assert.match(ps('git reset --hard'), /reset --hard/);
  assert.equal(ps('git add src/a.js'), null);
});

test('a commit message in a command substitution never turns a body line into a command', () => {
  const body = 'fix the "x problem';
  const msg = (line) => `git commit -m "$(cat <<'EOF'\nsubject\n\n${body}\n${line}\nEOF\n)" -- f`;
  assert.equal(verdict(msg('git reset --hard is now blocked')), null);
  assert.equal(verdict(msg('git add -A is mentioned here')), null);
  assert.equal(verdict(msg('plain text')), null);
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
