#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isMain, run } from '../lib/hook-io.mjs';
import { simpleCommands } from '../lib/shell.mjs';

const LAUNCHERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'env']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
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

function checkPush(args, env) {
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
      if (args.some((a) => a === '.' || a === '--all' || clusterBeforeValue(a, '').includes('A'))) {
        return 'git add -A, --all and . stage everything in the repository, including other agents\' files. Name the paths you changed, for example git add src/a.js.';
      }
      return null;
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
      return checkPush(args, env);
    case 'reset':
      return has('--hard') ? 'git reset --hard throws away uncommitted work, possibly another agent\'s. Use git restore on the specific files you own, or git reset --soft to move the branch only.' : null;
    case 'clean':
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
      if (!args[0] || args[0].startsWith('-') || args[0] === 'push' || args[0] === 'save') {
        return 'git stash sweeps every uncommitted change in a shared worktree into one place, including other agents\' work. Commit your own files by name instead; git stash list, show, pop and apply are fine.';
      }
      return null;
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

function checkWords(raw, cwd, env, depth = 0) {
  let words = raw;
  while (LAUNCHERS.has(words[0])) words = words.slice(1);
  if (SHELLS.has(words[0]) && words[1] === '-c' && words[2] && depth < 3) {
    for (const inner of simpleCommands(words[2])) {
      const reason = checkWords(inner, cwd, env, depth + 1);
      if (reason) return reason;
    }
    return null;
  }
  if (words[0] === 'git') return checkGit(words, cwd, env);
  if (words[0] === 'rm') return checkRm(words);
  return null;
}

/** Returns a deny reason, or null to allow. */
export function check(input, env = process.env) {
  if (input.tool_name !== 'Bash') return null;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  for (const words of simpleCommands(command)) {
    const reason = checkWords(words, input.cwd, env);
    if (reason) return reason;
  }
  return null;
}

if (isMain(import.meta.url)) await run('git-guard', (input) => check(input));
