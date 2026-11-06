import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check } from '../hooks/secret-guard.mjs';

const script = fileURLToPath(new URL('../hooks/secret-guard.mjs', import.meta.url));
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (content) => ({ tool_name: 'Write', tool_input: { file_path: 'a.txt', content } });
const edit = (new_string) => ({ tool_name: 'Edit', tool_input: { file_path: 'a.txt', old_string: 'x', new_string } });

// Fixtures are built at run time so no token-like literal sits in the repository.
const body = (n) => 'Q7zK9mW2xV4nB8rT1yH5jL3cD6fG0sPaE'.repeat(3).slice(0, n);
const fixtures = {
  'a GitHub token': 'ghp_' + body(36),
  'a GitHub token (fine-grained)': 'github_pat_' + body(40),
  'an Anthropic API key': 'sk-ant-' + body(40),
  'an API key': 'sk-' + body(32),
  'an AWS access key id': 'AKIA' + 'Q7ZK9MW2XV4NB8RT'.slice(0, 16),
  'a Slack token': 'xoxb-' + '1234567890-' + body(20),
  'a private key': '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----',
};

test('Bash: reading env files is denied', () => {
  for (const c of ['cat .env', 'cat .env.local', 'head -5 .env.production', 'tail app/.env', 'less .env', 'more .env.local', 'type .env', 'cat < .env', 'cat <.env', 'cat "src/sub/.env"', 'ls && cat .env', 'bash -c "cat .env"']) {
    assert.match(check(bash(c)), /\.env/, c);
  }
});

test('Bash: template env files and other files pass', () => {
  for (const c of ['cat .env.example', 'cat .env.sample', 'cat .env.template', 'cat .envrc.md', 'cat README.md', 'ls .env', 'grep -c x notes.env.txt', 'echo ".env"']) {
    assert.equal(check(bash(c)), null, c);
  }
});

test('Bash: printenv and env dumps', () => {
  for (const c of ['printenv', 'printenv GITHUB_TOKEN', 'printenv MY_SECRET', 'printenv api_key', 'printenv DB_PASSWORD', 'env', 'env | sort', 'env | grep TOKEN']) {
    assert.notEqual(check(bash(c)), null, c);
  }
  for (const c of ['printenv HOME', 'printenv PATH', 'env FOO=1 node x.js', 'environment']) {
    assert.equal(check(bash(c)), null, c);
  }
});

test('Bash: echo or printf of a secret variable', () => {
  for (const c of ['echo $GITHUB_TOKEN', 'echo "$API_KEY"', 'printf "%s" ${DB_PASSWORD}', 'echo token=$MY_SECRET']) {
    assert.notEqual(check(bash(c)), null, c);
  }
  for (const c of ['echo $HOME', 'echo "my key idea"', 'echo hello', 'printf "%s" "$PATH"']) {
    assert.equal(check(bash(c)), null, c);
  }
});

test('Bash: gh auth token and vercel env pull', () => {
  assert.match(check(bash('gh auth token')), /gh auth token/);
  assert.match(check(bash('npx vercel env pull .env.local')), /vercel env pull/);
  assert.equal(check(bash('gh auth status')), null);
  assert.equal(check(bash('vercel env ls')), null);
  assert.equal(check(bash('git commit -m "document gh auth token"')), null);
});

test('Write and Edit: known credential shapes are denied', () => {
  for (const [label, token] of Object.entries(fixtures)) {
    assert.match(check(write(`const t = "${token}";`)), new RegExp(label.split(' (')[0]), label);
    assert.notEqual(check(edit(`x ${token} y`)), null, label);
  }
});

test('NotebookEdit and MultiEdit content is scanned too', () => {
  const token = fixtures['a GitHub token'];
  assert.notEqual(check({ tool_name: 'NotebookEdit', tool_input: { new_source: token } }), null);
  assert.notEqual(check({ tool_name: 'MultiEdit', tool_input: { edits: [{ new_string: 'ok' }, { new_string: token }] } }), null);
});

test('placeholders and ordinary text are allowed', () => {
  for (const s of ['token = "ghp_xxx"', 'ghp_' + 'x'.repeat(36), 'sk-your-key-here', 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxx', 'AKIA is a prefix', 'xoxb-xxxxxxxxxxxx', 'risk-assessment-for-the-quarter-report', '-----BEGIN CERTIFICATE-----', 'plain text']) {
    assert.equal(check(write(s)), null, s);
  }
});

test('the deny reason never repeats any characters of the token', () => {
  for (const [label, token] of Object.entries(fixtures)) {
    const reason = check(write(`secret ${token}`));
    assert.ok(reason, label);
    const secretPart = token.replace(/^(?:ghp_|github_pat_|sk-ant-|sk-|xoxb-|AKIA|-----BEGIN )/, '');
    for (let i = 0; i + 5 <= secretPart.length; i++) {
      assert.ok(!reason.includes(secretPart.slice(i, i + 5)), `${label}: reason repeats ${i}`);
    }
  }
});

test('other tools are ignored', () => {
  assert.equal(check({ tool_name: 'Read', tool_input: { file_path: '.env' } }), null);
  assert.equal(check({ tool_name: 'Bash', tool_input: {} }), null);
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('script: prints a deny decision', () => {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(bash('cat .env')), encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
