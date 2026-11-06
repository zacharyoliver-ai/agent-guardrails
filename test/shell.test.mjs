import test from 'node:test';
import assert from 'node:assert/strict';
import { simpleCommands, withoutInput } from '../lib/shell.mjs';

test('separators split commands and quotes group words', () => {
  assert.deepEqual(simpleCommands('a b && c "d e" | f; g\nh'), [['a', 'b'], ['c', 'd e'], ['f'], ['g'], ['h']]);
});

test('leading assignments, comments and heredoc bodies are dropped', () => {
  assert.deepEqual(simpleCommands('X=1 run # note'), [['run']]);
  assert.deepEqual(simpleCommands("cat <<'EOF'\ngit add -A\nEOF\nnext"), [['cat'], ['next']]);
});

test('a command substitution inside double quotes yields its commands', () => {
  assert.deepEqual(simpleCommands('echo "$(git status)"'), [['git', 'status'], ['echo', '']]);
  assert.deepEqual(simpleCommands('echo "a $(b $(c)) d"'), [['b', '$'], ['c'], ['echo', 'a  d']]);
});

test('backticks inside double quotes yield their commands, and escaped ones stay text', () => {
  assert.deepEqual(simpleCommands('echo "`git status`"'), [['git', 'status'], ['echo', '']]);
  assert.deepEqual(simpleCommands('echo "a \\`b\\` c"'), [['echo', 'a `b` c']]);
});

test('a stray double quote inside a heredoc in a substitution does not end the string', () => {
  const src = `git commit -m "$(cat <<'EOF'\nfix the "x problem\ngit reset --hard is now blocked\nEOF\n)" -- f`;
  const cmds = simpleCommands(src).map((w) => w.join(' '));
  assert.ok(cmds.includes('cat'));
  assert.ok(cmds.some((c) => c.startsWith('git commit -m')));
  assert.ok(!cmds.some((c) => c.includes('reset')));
});

test('output redirections and their targets are not words', () => {
  assert.deepEqual(simpleCommands('run a 2>&1 | tail'), [['run', 'a'], ['tail']]);
  assert.deepEqual(simpleCommands('run a > out.txt b'), [['run', 'a', 'b']]);
  assert.deepEqual(simpleCommands('run a >> "my log.txt" 2>err.txt'), [['run', 'a']]);
  assert.deepEqual(simpleCommands('run a &> out.txt b'), [['run', 'a', 'b']]);
  assert.deepEqual(simpleCommands('run a &>> out.txt; next'), [['run', 'a'], ['next']]);
  assert.deepEqual(simpleCommands('run a >&2'), [['run', 'a']]);
  assert.deepEqual(simpleCommands('run a *>&1'), [['run', 'a']]);
  assert.deepEqual(simpleCommands('run a >| out.txt'), [['run', 'a']]);
  assert.deepEqual(simpleCommands('> out.txt run a'), [['run', 'a']]);
});

test('what looks like a redirection but is not one stays', () => {
  assert.deepEqual(simpleCommands('cat < a.txt'), [['cat', '<', 'a.txt']]);
  assert.deepEqual(simpleCommands('cat <a.txt'), [['cat', '<a.txt']]);
  assert.deepEqual(withoutInput(['cat', '<', 'a.txt', 'b.txt']), ['cat', 'b.txt']);
  assert.deepEqual(withoutInput(['cat', '<a.txt', 'b.txt']), ['cat', 'b.txt']);
  assert.deepEqual(simpleCommands('run a & next'), [['run', 'a'], ['next']]);
  assert.deepEqual(simpleCommands('echo "a > b" c'), [['echo', 'a > b', 'c']]);
  assert.deepEqual(simpleCommands('echo a2>x'), [['echo', 'a2']]);
});

test('a redirection never hides a command', () => {
  assert.deepEqual(simpleCommands('run >\ngit status'), [['run'], ['git', 'status']]);
  assert.ok(simpleCommands('echo x > $(git status)').some((w) => w[0] === 'git'));
  assert.ok(simpleCommands('echo x > "$(git status)"').some((w) => w[0] === 'git'));
  assert.ok(simpleCommands('echo x > >(git status)').some((w) => w[0] === 'git'));
});

test('an unterminated substitution does not throw', () => {
  assert.deepEqual(simpleCommands('echo "$(git status'), [['git', 'status'], ['echo', '']]);
});
