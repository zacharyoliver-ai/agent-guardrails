#!/usr/bin/env node
import { isMain, run } from '../lib/hook-io.mjs';
import { simpleCommands } from '../lib/shell.mjs';

const LAUNCHERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'npx']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// The word must stand alone in the name: API_KEY and KEY match, KEYBOARD and MONKEY do not.
const SECRET_NAME = /(?:^|_)(?:TOKEN|SECRET|KEY|PASSWORD)(?:$|_)/i;
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/;
const ENV_TEMPLATE = /\.(?:example|sample|template)$/;
const PROC_ENVIRON = /^\/proc\/[^/]+\/environ$/;
// Commands that print or load the contents of a file named on their line.
const READERS = new Set([
  'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'bat', 'type', 'strings', 'xxd', 'od', 'base64', 'cut', 'sort', 'uniq', 'jq',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'source', '.',
  'get-content', 'gc', 'select-string', 'sls',
]);
// For these the first argument that is not an option is the pattern or script, not a file.
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'select-string', 'sls']);

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
const isSecretFile = (word) => isEnvFile(word) || PROC_ENVIRON.test(word.replace(/^</, ''));

const ENV_FILE_REASON =
  'Reading an .env file or the process environment prints its credentials into the session. To see which variables exist, read .env.example, or ask for a check that prints only whether a named variable is set.';
const ENV_VAR_REASON =
  'That prints a credential into the session. Check whether the variable is set without printing it, for example test -n "$NAME" && echo set. To list names only, run node -p "Object.keys(process.env)".';

/** Names of variables the shell would expand: $NAME or ${NAME} outside single quotes. */
function expandedVars(command) {
  const names = new Set();
  let single = false;
  let double = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && !single) i++;
    else if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === '$' && !single) {
      const m = /^\$\{?([A-Za-z_]\w*)/.exec(command.slice(i));
      if (m) names.add(m[1]);
    }
  }
  return names;
}

function checkWords(raw, vars, depth = 0) {
  let w = raw;
  while (LAUNCHERS.has(w[0])) w = w.slice(1);
  const [first, a, b] = w;
  const cmd = String(first).toLowerCase();
  const args = w.slice(1);
  if (SHELLS.has(cmd) && a === '-c' && b && depth < 3) {
    for (const inner of simpleCommands(b)) {
      const reason = checkWords(inner, vars, depth + 1);
      if (reason) return reason;
    }
    return null;
  }
  if (READERS.has(cmd)) {
    let files = args;
    if (PATTERN_FIRST.has(cmd)) {
      const at = files.findIndex((x) => !x.startsWith('-'));
      files = files.filter((_, i) => i !== at);
    }
    if (files.some(isSecretFile)) return ENV_FILE_REASON;
  }
  if (cmd === 'printenv') {
    const names = args.filter((x) => !x.startsWith('-'));
    return names.length === 0 || names.some((n) => SECRET_NAME.test(n)) ? ENV_VAR_REASON : null;
  }
  if (cmd === 'env' && args.length === 0) return ENV_VAR_REASON;
  if (cmd === 'echo' || cmd === 'printf') {
    const prints = args.some((x) => [...x.matchAll(/\$\{?([A-Za-z_]\w*)/g)].some((m) => vars.has(m[1]) && SECRET_NAME.test(m[1])));
    if (prints) return ENV_VAR_REASON;
  }
  if (cmd === 'gh' && a === 'auth' && (b === 'token' || (b === 'status' &&(args.includes('--show-token') || args.includes('-t'))))) {
    return 'gh auth token prints the stored GitHub token, and so does gh auth status --show-token. Use gh commands directly; they authenticate by themselves.';
  }
  if (cmd === 'vercel' && args.some((x, i) => x === 'env' && args[i + 1] === 'pull')) {
    return 'vercel env pull writes production credentials into a local file. Ask the user for the one value you need instead.';
  }
  return null;
}

/** Names the kind of credential found in text, or null. Never returns any of its characters. */
export function findCredential(text) {
  for (const [label, re] of SHAPES) {
    for (const m of text.matchAll(re)) {
      const body = m[0].replace(/^(?:ghp_|github_pat_|sk-ant-|sk-(?:proj-|svcacct-)?|xoxb-|AKIA)/, '');
      // Documentation examples end in EXAMPLE.
      if (!PLACEHOLDER.test(body) && !body.endsWith('EXAMPLE')) return label;
    }
  }
  return null;
}

function writtenText(toolInput) {
  const parts = [toolInput.content, toolInput.new_string, toolInput.new_source];
  for (const e of Array.isArray(toolInput.edits) ? toolInput.edits : []) parts.push(e?.new_string);
  return parts.filter((p) => typeof p === 'string');
}

const writeReason = (label) =>
  `The new content contains what looks like ${label}. Do not write credentials into files. Read the value from an environment variable at run time and put a placeholder such as ghp_xxx in the file.`;

// A command that redirects or tees output, or writes a file from PowerShell.
const WRITES_FILE = /\d?>|\btee\b|\b(?:set|add)-content\b|\bout-file\b/i;

/** Returns a deny reason, or null to allow. */
export function check(input) {
  const ti = input.tool_input || {};
  if (SHELL_TOOLS.has(input.tool_name)) {
    if (typeof ti.command !== 'string') return null;
    // In PowerShell a backslash separates path parts, and the tokenizer would read it as an escape.
    const command = input.tool_name === 'PowerShell' ? ti.command.replace(/\\/g, '/') : ti.command;
    const vars = expandedVars(command);
    for (const words of simpleCommands(command)) {
      const reason = checkWords(words, vars);
      if (reason) return reason;
    }
    // Known limit: a key typed into any command that writes a file is refused, even a harmless one.
    const label = WRITES_FILE.test(command) ? findCredential(command) : null;
    return label ? writeReason(label) : null;
  }
  if (input.tool_name === 'Read') return isSecretFile(String(ti.file_path ?? '')) ? ENV_FILE_REASON : null;
  if (input.tool_name === 'Grep') return isSecretFile(String(ti.path ?? '')) ? ENV_FILE_REASON : null;
  for (const text of writtenText(ti)) {
    const label = findCredential(text);
    if (label) return writeReason(label);
  }
  return null;
}

if (isMain(import.meta.url)) await run('secret-guard', (input) => check(input));
