#!/usr/bin/env node
import { isMain, run } from '../lib/hook-io.mjs';
import { simpleCommands } from '../lib/shell.mjs';

const LAUNCHERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'npx']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD/i;
const SECRET_VAR = /\$\{?[A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*/i;
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/;
const ENV_TEMPLATE = /\.(?:example|sample|template)$/;

// Credential shapes by their published prefixes. A body made only of x, * or
// dots is a placeholder and passes.
const SHAPES = [
  ['a GitHub token', /ghp_[A-Za-z0-9]{20,}/g],
  ['a GitHub token', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['an API key', /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/g],
  ['an AWS access key id', /AKIA[0-9A-Z]{16}/g],
  ['a Slack token', /xoxb-[A-Za-z0-9-]{10,}/g],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY/g],
];
const PLACEHOLDER = /^[xX*._-]+$/;

const isEnvFile = (word) => {
  const base = word.replace(/^</, '').replace(/\\/g, '/').split('/').pop();
  return ENV_FILE.test(base) && !ENV_TEMPLATE.test(base);
};

const ENV_FILE_REASON =
  'Reading an .env file prints its credentials into the session. To see which variables exist, read .env.example, or ask for a check that prints only whether a named variable is set.';
const ENV_VAR_REASON =
  'That prints a credential into the session. Check whether the variable is set without printing it, for example test -n "$NAME" && echo set.';

function checkWords(raw, depth = 0) {
  let w = raw;
  while (LAUNCHERS.has(w[0])) w = w.slice(1);
  const [cmd, a, b] = w;
  const args = w.slice(1);
  if (SHELLS.has(cmd) && a === '-c' && b && depth < 3) {
    for (const inner of simpleCommands(b)) {
      const reason = checkWords(inner, depth + 1);
      if (reason) return reason;
    }
    return null;
  }
  if (['cat', 'head', 'tail', 'less', 'more', 'type'].includes(cmd) && args.some(isEnvFile)) return ENV_FILE_REASON;
  if (cmd === 'printenv') {
    const names = args.filter((x) => !x.startsWith('-'));
    return names.length === 0 || names.some((n) => SECRET_NAME.test(n)) ? ENV_VAR_REASON : null;
  }
  if (cmd === 'env' && args.length === 0) return ENV_VAR_REASON;
  if ((cmd === 'echo' || cmd === 'printf') && args.some((x) => SECRET_VAR.test(x))) return ENV_VAR_REASON;
  if (cmd === 'gh' && a === 'auth' && b === 'token') {
    return 'gh auth token prints the stored GitHub token. Use gh commands directly; they authenticate by themselves.';
  }
  if (cmd === 'vercel' && a === 'env' && b === 'pull') {
    return 'vercel env pull writes production credentials into a local file. Ask the user for the one value you need instead.';
  }
  return null;
}

/** Names the kind of credential found in text, or null. Never returns any of its characters. */
export function findCredential(text) {
  for (const [label, re] of SHAPES) {
    for (const m of text.matchAll(re)) {
      const body = m[0].replace(/^(?:ghp_|github_pat_|sk-ant-|sk-|xoxb-)/, '');
      if (!PLACEHOLDER.test(body)) return label;
    }
  }
  return null;
}

function writtenText(toolInput) {
  const parts = [toolInput.content, toolInput.new_string, toolInput.new_source];
  for (const e of Array.isArray(toolInput.edits) ? toolInput.edits : []) parts.push(e?.new_string);
  return parts.filter((p) => typeof p === 'string');
}

/** Returns a deny reason, or null to allow. */
export function check(input) {
  const ti = input.tool_input || {};
  if (input.tool_name === 'Bash') {
    if (typeof ti.command !== 'string') return null;
    for (const words of simpleCommands(ti.command)) {
      const reason = checkWords(words);
      if (reason) return reason;
    }
    return null;
  }
  for (const text of writtenText(ti)) {
    const label = findCredential(text);
    if (label) {
      return `The new content contains what looks like ${label}. Do not write credentials into files. Read the value from an environment variable at run time and put a placeholder such as ghp_xxx in the file.`;
    }
  }
  return null;
}

if (isMain(import.meta.url)) await run('secret-guard', (input) => check(input));
