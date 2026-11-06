#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isMain, run } from '../lib/hook-io.mjs';
import { simpleCommands, withoutInput } from '../lib/shell.mjs';

// Words that run the next command. `values` are their flags that take a separate value;
// `positional` counts plain arguments before the command (timeout 60 git ...).
const LAUNCHERS = new Map([
  ['sudo', { values: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U']) }],
  ['doas', { values: new Set(['-u', '-C']) }],
  ['env', { values: new Set(['-u', '-C', '-S']) }],
  ['nice', { values: new Set(['-n']) }],
  ['ionice', { values: new Set(['-c', '-n', '-p']) }],
  ['xargs', { values: new Set(['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a', '-l', '-i']) }],
  ['timeout', { values: new Set(['-s', '-k']), positional: 1 }],
  ['time', { values: new Set(['-f', '-o']) }],
  ['command', { values: new Set() }],
  ['nohup', { values: new Set() }],
  ['exec', { values: new Set(['-a']) }],
  ['setsid', { values: new Set() }],
  ['builtin', { values: new Set() }],
]);
// Shell keywords that can stand in front of a command: `if true; then git add -A; fi`.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
const COMMIT_VALUE_FLAGS = new Set(['-m', '-F', '-C', '-c', '-t', '--message', '--file', '--reuse-message', '--reedit-message', '--template']);
const DANGEROUS_RM = new Set(['/', '/*', '~', '~/*', '$HOME', '${HOME}', '$HOME/*', '.', './*', '*', '..']);

const shortFlags = (arg) => (/^-[A-Za-z]+$/.test(arg) ? arg.slice(1) : '');

/** Letters of a short-flag cluster up to the first one that takes a value. */
function clusterBeforeValue(arg, valueLetters) {
  const out = [];
  for (const ch of shortFlags(arg)) {
    out.push(ch);
    if (valueLetters.includes(ch)) break;
  }
  return out;
}

const SWEEP_PATHS = new Set(['.', './', ':/', '*']);

/** Named paths among the arguments: no flags, no "--", no value of a flag that takes one. */
function namedPaths(args, takesValue = () => false) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (takesValue(args[i])) i++;
    else if (!args[i].startsWith('-')) out.push(args[i]);
  }
  return out;
}

function checkWorktreeRemove(args, cwd) {
  const target = args.slice(1).find((a) => !a.startsWith('-'));
  if (!target) return null;
  const modules = path.join(path.resolve(cwd || process.cwd(), target), 'node_modules');
  try {
    if (!fs.lstatSync(modules).isSymbolicLink()) return null;
  } catch {
    return null; // no node_modules there, or the path does not exist
  }
  return `The node_modules folder in ${target} is a link to an install other worktrees share, and removing the worktree can delete that shared install. Remove the link first (rmdir on Windows, rm without -r elsewhere, on that node_modules path only), then run git worktree remove again.`;
}

/** Current branch of the repository at cwd, or '' when it cannot be read (the guard then allows). */
function currentBranch(cwd) {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: cwd || process.cwd(),
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function checkPush(args, env, cwd) {
  const force = args.find((a) => a === '--force' || (a.startsWith('-') && !a.startsWith('--') && clusterBeforeValue(a, 'o').includes('f')));
  const positional = args.filter((a) => !a.startsWith('-'));
  if (force || positional.some((a) => a.startsWith('+'))) {
    return 'A forced push can overwrite commits other agents rely on. Use git push --force-with-lease if the remote branch really must be replaced, or push normally.';
  }
  if (env.GUARDRAILS_GIT_ALLOW_MAIN === '1') return null;
  for (const spec of positional.slice(1)) {
    const target = spec.includes(':') ? spec.split(':').pop() : spec;
    if (/^(?:refs\/heads\/)?(?:main|master)$/.test(target)) {
      return 'Pushing straight to main or master is blocked. Push a branch and open a pull request, or ask the user to approve the push to main.';
    }
  }
  // No refspec, or HEAD, pushes whatever branch is checked out.
  const specs = positional.slice(1);
  const pushesHead = !args.includes('--tags') && (specs.length === 0 || specs.includes('HEAD'));
  if (pushesHead && /^(?:main|master)$/.test(currentBranch(cwd))) {
    return 'This push would send the checked-out main or master branch, and pushing straight to it is blocked. Switch to a feature branch and open a pull request, or ask the user to approve the push to main.';
  }
  return null;
}

function checkGit(words, cwd, env) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-C' && words[i + 1]) cwd = path.resolve(cwd || process.cwd(), words[i + 1]);
    i += VALUE_GLOBALS.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  const has = (...flags) => args.some((a) => flags.includes(a));

  switch (sub) {
    case 'add':
    {
      // A named path stages only what is named; a sweep flag or a "." path stages everything.
      const paths = namedPaths(args);
      const sweepFlag = args.some((a) => a === '--all' || a === '--update' || ['A', 'u'].some((f) => clusterBeforeValue(a, '').includes(f)));
      if (paths.some((p) => SWEEP_PATHS.has(p)) || (sweepFlag && !paths.length)) {
        return 'git add -A, --all, -u and . stage everything in the repository, including other agents\' files. Name the paths you changed, for example git add src/a.js.';
      }
      return null;
    }
    case 'commit': {
      for (let j = 0; j < args.length && args[j] !== '--'; j++) {
        if (args[j] === '--all' || (!args[j].startsWith('--') && clusterBeforeValue(args[j], 'mFCct').includes('a'))) {
          return 'git commit -a and -am commit every tracked change in the worktree, including other agents\' edits. Commit only your files: git commit -m "message" -- path/one path/two.';
        }
        if (COMMIT_VALUE_FLAGS.has(args[j])) j++;
      }
      return null;
    }
    case 'push':
      return checkPush(args, env, cwd);
    case 'reset':
      return has('--hard') ? 'git reset --hard throws away uncommitted work, possibly another agent\'s. Use git restore on the specific files you own, or git reset --soft to move the branch only.' : null;
    case 'clean':
      if (args.some((a) => a === '--dry-run' || shortFlags(a).includes('n'))) return null;
      if (args.some((a) => a === '--force' || clusterBeforeValue(a, '').includes('f'))) {
        return 'git clean -f deletes untracked files for good, including files other agents just created. Delete the specific files you made, by name.';
      }
      return null;
    case 'checkout':
    case 'restore': {
      const dot = args.includes('.');
      const stagedOnly = sub === 'restore' && has('--staged', '-S') && !has('--worktree', '-W');
      if (dot && !stagedOnly && (sub === 'restore' || args.includes('--') || args.length === 1)) {
        return `git ${sub} . discards every uncommitted change in the directory, other agents' included. Restore the specific files you own by name.`;
      }
      return null;
    }
    case 'stash':
    {
      if (args[0] && !args[0].startsWith('-') && args[0] !== 'push' && args[0] !== 'save') return null;
      const paths = namedPaths(args.slice(args[0] === 'push' ? 1 : 0), (a) => a === '--message' || /^-[A-Za-z]*m$/.test(a));
      if (args[0] === 'save' || !paths.length || paths.some((p) => SWEEP_PATHS.has(p))) {
        return 'git stash sweeps every uncommitted change in a shared worktree into one place, including other agents\' work. Commit your own files by name instead, or name the paths to stash: git stash push -- path/one. git stash list, show, pop and apply are fine.';
      }
      return null;
    }
    case 'worktree':
      return args[0] === 'remove' ? checkWorktreeRemove(args, cwd) : null;
    default:
      return null;
  }
}

function checkRm(words) {
  const args = words.slice(1);
  const recursive = args.some((a) => a === '--recursive' || (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)));
  if (!recursive) return null;
  const hit = args.filter((a) => !a.startsWith('-')).some((a) => {
    const t = a.length > 1 ? a.replace(/\/+$/, '') || '/' : a;
    return DANGEROUS_RM.has(t) || /^[A-Za-z]:[\\/]?$/.test(t);
  });
  return hit ? 'That rm -r would delete the root, the home folder, the current directory or everything in it. Name the exact folder to remove, for example rm -rf build/.' : null;
}

/** Program name of a command word: /usr/bin/git and git.exe both read as git. */
const program = (w = '') => w.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();

/** Drops the launcher word, its flags and its values, and any NAME=value words. */
function skipLauncher(words) {
  const spec = LAUNCHERS.get(program(words[0]));
  let i = 1;
  let positional = spec.positional || 0;
  while (i < words.length) {
    const w = words[i];
    if (w.startsWith('-') && w !== '-') i += spec.values.has(w) ? 2 : 1;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (positional > 0) {
      positional--;
      i++;
    } else break;
  }
  return words.slice(i);
}

function checkWords(raw, cwd, env, depth = 0) {
  let words = withoutInput(raw);
  while (words.length && (LAUNCHERS.has(program(words[0])) || KEYWORDS.has(words[0]))) {
    words = KEYWORDS.has(words[0]) ? words.slice(1) : skipLauncher(words);
  }
  if (!words.length) return null;
  const name = program(words[0]);
  const inner = [];
  if (SHELLS.has(name) && depth < 3) {
    const c = words.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    if (c > 0 && words[c + 1]) inner.push(words[c + 1]);
  } else if (name === 'eval' && depth < 3) inner.push(words.slice(1).join(' '));
  if (inner.length) {
    for (const cmd of simpleCommands(inner[0])) {
      const reason = checkWords(cmd, cwd, env, depth + 1);
      if (reason) return reason;
    }
    return null;
  }
  if (name === 'git') return checkGit(words, cwd, env);
  if (name === 'rm') return checkRm(words);
  return null;
}

/** Returns a deny reason, or null to allow. */
export function check(input, env = process.env) {
  if (!SHELL_TOOLS.has(input.tool_name)) return null;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  let cwd = input.cwd;
  for (const words of simpleCommands(command)) {
    // Known limit: a cd inside a subshell still counts for what follows it. A folder that doesn't resolve reads as no branch, which allows.
    if (words[0] === 'cd' && words[1] && !words[1].startsWith('-')) cwd = path.resolve(cwd || process.cwd(), words[1]);
    const reason = checkWords(words, cwd, env);
    if (reason) return reason;
  }
  return null;
}

if (isMain(import.meta.url)) await run('git-guard', (input) => check(input));
