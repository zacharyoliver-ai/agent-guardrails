import test from 'node:test';
import assert from 'node:assert/strict';
import { simpleCommands } from '../lib/shell.mjs';

test('quoted text is one word, never a command', () => {
  assert.deepEqual(simpleCommands('git commit -m "never use git add -A"'), [['git', 'commit', '-m', 'never use git add -A']]);
  assert.deepEqual(simpleCommands("echo 'a && b; c | d'"), [['echo', 'a && b; c | d']]);
});

test('leading assignments are stripped', () => {
  assert.deepEqual(simpleCommands('FOO=1 git add -A'), [['git', 'add', '-A']]);
  assert.deepEqual(simpleCommands('A=1 B=2 node x.js'), [['node', 'x.js']]);
  assert.deepEqual(simpleCommands('FOO=1'), []);
  assert.deepEqual(simpleCommands('echo FOO=1'), [['echo', 'FOO=1']]);
});

test('splits on && || ; | and newlines', () => {
  assert.deepEqual(simpleCommands('a 1 && b 2 || c; d | e\nf'), [['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f']]);
});

test('backslash escapes keep the character in the word', () => {
  assert.deepEqual(simpleCommands('echo a\\ b \\;'), [['echo', 'a b', ';']]);
  assert.deepEqual(simpleCommands('echo "say \\"hi\\" ; there"'), [['echo', 'say "hi" ; there']]);
  assert.deepEqual(simpleCommands('echo one \\\ntwo'), [['echo', 'one', 'two']]);
});

test('heredoc bodies are removed', () => {
  const line = "cat <<'EOF' > f.txt\ngit add -A\nrm -rf /\nEOF\nls";
  assert.deepEqual(simpleCommands(line), [['cat', '>', 'f.txt'], ['ls']]);
  assert.deepEqual(simpleCommands('cat <<-X\n  body\n  X\necho done'), [['cat'], ['echo', 'done']]);
  assert.deepEqual(simpleCommands('cat <<EOF\r\nbody\r\nEOF\r\nls'), [['cat'], ['ls']]);
});

test('here-strings are not heredocs', () => {
  assert.deepEqual(simpleCommands('cat <<< "hi"\nls'), [['cat', '<<<', 'hi'], ['ls']]);
});

test('comments are dropped but # inside a word stays', () => {
  assert.deepEqual(simpleCommands('ls # git add -A\npwd'), [['ls'], ['pwd']]);
  assert.deepEqual(simpleCommands('echo a#b'), [['echo', 'a#b']]);
});

test('empty quoted word is kept, empty input gives nothing', () => {
  assert.deepEqual(simpleCommands('echo ""'), [['echo', '']]);
  assert.deepEqual(simpleCommands(''), []);
  assert.deepEqual(simpleCommands(undefined), []);
});

test('subshell and backtick contents become their own commands', () => {
  assert.deepEqual(simpleCommands('(cd x && ls)'), [['cd', 'x'], ['ls']]);
  assert.deepEqual(simpleCommands('echo `date`'), [['echo'], ['date']]);
});

test('an unterminated quote does not throw', () => {
  assert.deepEqual(simpleCommands('echo "abc'), [['echo', 'abc']]);
  assert.deepEqual(simpleCommands("echo 'abc"), [['echo', 'abc']]);
});
