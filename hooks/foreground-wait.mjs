#!/usr/bin/env node
import fs from 'node:fs';
import { isMain, run } from '../lib/hook-io.mjs';
import { simpleCommands } from '../lib/shell.mjs';

const WRAPPERS = new Set(['npx', 'time', 'nohup', 'exec', 'command', 'sudo', 'nice', 'env']);
// Flags of test runners that take a value, so the value is not mistaken for a file.
const VALUE_FLAGS = new Set([
  '-k', '-m', '-n', '-g', '-j', '-p', '-c', '--project', '--grep', '--reporter', '--workers',
  '--config', '--timeout', '--retries', '--shard', '--test-name-pattern', '--test-reporter',
  '--test-concurrency', '--test-timeout', '--import', '--require', '--env-file',
]);
const GLOB = /[*?[{]/;
const SOURCE_FILE = /\.\w+(?:::.*)?$/;

/** Drops launcher words (npx, time, timeout 60, ...) so the real command comes first. */
function unwrap(words) {
  let w = words;
  for (;;) {
    if (w[0] === 'timeout') w = w.slice(/^-/.test(w[1] ?? '') ? 3 : 2);
    else if (WRAPPERS.has(w[0])) {
      w = w.slice(1);
      while (w[0]?.startsWith('-')) w = w.slice(1);
    } else return w;
  }
}

/** Positional arguments, skipping flags and the values of known value flags. */
function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** True when the arguments name one to three concrete files, so the run is short. */
function fewFiles(args) {
  const files = positionals(args);
  if (files.length < 1 || files.length > 3) return false;
  return files.every((f) => !GLOB.test(f) && SOURCE_FILE.test(f));
}

const seconds = (arg) => {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(arg);
  return m ? Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : 0;
};

/** Returns a short description of the long run this command starts, or null. */
export function longRun(words) {
  const w = unwrap(words);
  const [cmd, a = '', b = ''] = w;
  if (!cmd) return null;
  const rest = w.slice(1);

  if (rest.some((x) => x === '--watch' || x.startsWith('--watch='))) return 'a watcher (--watch)';
  if (cmd === 'tail' && rest.some((x) => x === '--follow' || /^-[a-zA-Z0-9]*[fF][a-zA-Z0-9]*$/.test(x))) return 'tail -f';
  if (cmd === 'sleep' && rest.reduce((sum, x) => sum + seconds(x), 0) >= 30) return 'a sleep of 30 seconds or more';

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd)) {
    const script = a === 'run' || a === 'run-script' ? b : a;
    const args = w.slice(a === 'run' || a === 'run-script' ? 3 : 2);
    if (['test', 't'].includes(script) && !fewFiles(args)) return `a full test run (${cmd} ${script})`;
    if (script === 'build') return `a build (${cmd} run build)`;
    return null;
  }
  if (cmd === 'pytest' || cmd === 'py.test' || (/^python[\d.]*$/.test(cmd) && a === '-m' && b === 'pytest')) {
    const args = cmd.startsWith('py') && cmd !== 'pytest' && cmd !== 'py.test' ? w.slice(3) : rest;
    return fewFiles(args) ? null : 'a full pytest run';
  }
  if (cmd === 'go' && a === 'test') return rest.some((x) => x === './...' || x.endsWith('/...')) ? 'go test ./...' : null;
  if (cmd === 'cargo' && (a === 'test' || a === 'build')) return `cargo ${a}`;
  if (cmd === 'node' && rest.includes('--test')) return fewFiles(rest.filter((x) => x !== '--test')) ? null : 'a node --test run over many files';
  if (cmd === 'playwright' && a === 'test') return fewFiles(w.slice(2)) ? null : 'a full playwright run';
  if ((cmd === 'vite' || cmd === 'next') && a === 'build') return `${cmd} build`;
  if (cmd === 'docker' && a === 'build') return 'docker build';
  if (cmd === 'tsc') {
    if (rest.some((x) => ['--version', '-v', '--help', '-h'].includes(x))) return null;
    const files = rest.filter((x) => !x.startsWith('-') && /\.[cm]?[jt]sx?$/.test(x));
    return rest.includes('--noEmit') && files.length ? null : 'a tsc build';
  }
  return null;
}

function loadConfig(env) {
  const file = env.GUARDRAILS_LONG_RUNS;
  if (!file) return { add: [], allow: [] };
  const toRegex = (s) => {
    try {
      return new RegExp(s);
    } catch {
      return null;
    }
  };
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      add: (cfg.add || []).map(toRegex).filter(Boolean),
      allow: (cfg.allow || []).map(toRegex).filter(Boolean),
    };
  } catch {
    return { add: [], allow: [] }; // unreadable config: use the defaults
  }
}

/** Returns a deny reason, or null to allow. */
export function check(input, env = process.env) {
  if (input.tool_name !== 'Bash') return null;
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || input.tool_input.run_in_background === true) return null;
  const cfg = loadConfig(env);
  for (const words of simpleCommands(command)) {
    const text = words.join(' ');
    if (cfg.allow.some((re) => re.test(text))) continue;
    const what = longRun(words) || (cfg.add.some((re) => re.test(text)) ? `a configured long run (${text})` : null);
    if (what) {
      return `That is ${what}, which can take minutes. Run it again with run_in_background set to true and keep working on something else; read the output when it finishes. A test run over one to three named files may stay in the foreground.`;
    }
  }
  return null;
}

if (isMain(import.meta.url)) await run('foreground-wait', (input) => check(input));
