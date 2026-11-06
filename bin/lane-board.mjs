#!/usr/bin/env node
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';

const slash = (p) => p.replace(/\\/g, '/');
const lines = (s) => s.split(/\r?\n/).filter(Boolean);

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Parses `git worktree list --porcelain` into { path, head, branch } entries; bare trees are left out. */
export function parseWorktrees(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const wt = {};
    for (const l of lines(block)) {
      if (l.startsWith('worktree ')) wt.path = slash(l.slice(9));
      else if (l.startsWith('HEAD ')) wt.head = l.slice(5);
      else if (l.startsWith('branch ')) wt.branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l === 'bare') wt.bare = true;
    }
    if (wt.path && !wt.bare) out.push(wt);
  }
  return out;
}

function resolveBase(root, wanted) {
  const candidates = wanted ? [wanted] : ['origin/main', 'main', 'HEAD'];
  for (const ref of candidates) {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(wanted ? `base ref not found: ${wanted}` : 'no base ref found');
}

export function ageText(seconds) {
  if (seconds < 3600) return `${Math.max(0, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function laneInfo(wt, base, nowSec) {
  const mergeBase = git(wt.path, ['merge-base', base, 'HEAD']).trim();
  const [behind, ahead] = git(wt.path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]).trim().split(/\s+/).map(Number);
  const files = new Set();
  const add = (text) => lines(text).forEach((f) => files.add(slash(f)));
  // A squash-merged lane matches base again, so its files are finished work and no longer in progress.
  const differsFromBase = new Set(lines(git(wt.path, ['diff', '--name-only', base, 'HEAD'])));
  lines(git(wt.path, ['diff', '--name-only', mergeBase, 'HEAD'])).filter((f) => differsFromBase.has(f)).forEach((f) => files.add(slash(f)));
  add(git(wt.path, ['diff', '--name-only', '--cached']));
  add(git(wt.path, ['diff', '--name-only']));
  add(git(wt.path, ['ls-files', '--others', '--exclude-standard']));
  const committed = Number(git(wt.path, ['log', '-1', '--format=%ct']).trim());
  return {
    path: wt.path,
    label: wt.branch || path.posix.basename(wt.path),
    branch: wt.branch || `(detached ${String(wt.head || '').slice(0, 7)})`,
    ahead,
    behind,
    files: [...files].sort(),
    age: ageText(nowSec - committed),
  };
}

export function findOverlaps(lanes) {
  const byFile = new Map();
  for (const lane of lanes) {
    for (const f of lane.files) byFile.set(f, [...(byFile.get(f) || []), lane.label]);
  }
  return [...byFile].filter(([, who]) => who.length > 1).map(([file, who]) => ({ file, lanes: who.sort() })).sort((a, b) => a.file.localeCompare(b.file));
}

export function buildBoard(root, baseArg, nowSec = Math.floor(Date.now() / 1000)) {
  const base = resolveBase(root, baseArg);
  const lanes = parseWorktrees(git(root, ['worktree', 'list', '--porcelain'])).map((wt) => laneInfo(wt, base, nowSec));
  return { base, lanes, overlaps: findOverlaps(lanes) };
}

export function formatBoard(board) {
  const out = [`Base: ${board.base}`, '', 'LANES'];
  for (const l of board.lanes) {
    out.push(l.path, `  branch ${l.branch}  ahead ${l.ahead}  behind ${l.behind}  last commit ${l.age} ago`);
    out.push(l.files.length ? `  changed (${l.files.length}): ${l.files.join(', ')}` : '  changed: none');
  }
  out.push('', 'OVERLAPS');
  if (board.overlaps.length) for (const o of board.overlaps) out.push(`${o.file}: ${o.lanes.join(', ')}`);
  else out.push('none');
  return out.join('\n');
}

export function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { root: { type: 'string', default: process.cwd() }, base: { type: 'string' }, strict: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
    }));
  } catch (err) {
    process.stderr.write(`lane-board: ${err.message}\n`);
    return 2;
  }
  let board;
  try {
    board = buildBoard(path.resolve(values.root), values.base);
  } catch (err) {
    process.stderr.write(`lane-board: ${String(err.stderr || err.message).trim().split(/\r?\n/)[0]}\n`);
    return 2;
  }
  process.stdout.write((values.json ? JSON.stringify(board, null, 2) : formatBoard(board)) + '\n');
  return values.strict && board.overlaps.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
