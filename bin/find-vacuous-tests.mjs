#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';

const REGEX_PREV = new Set([...'(,=:[!&|?{};']);

/**
 * Blanks comments, string contents, template text and regex literals with spaces, keeping every
 * index and newline where it was. Code inside `${ }` stays visible. Also returns the lines
 * that carry a comment.
 */
export function mask(src) {
  const out = src.split('');
  const commentLines = new Set();
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let line = 1;
  let prev = '';
  let depth = 0;
  const templateAt = []; // brace depth at which each open `${` resumes the template
  let i = 0;

  const template = (from) => {
    let k = from;
    while (k < src.length) {
      const c = src[k];
      if (c === '\\') k += 2;
      else if (c === '`') {
        blank(from, k);
        return k + 1;
      } else if (c === '$' && src[k + 1] === '{') {
        blank(from, k + 2);
        templateAt.push(depth);
        depth++;
        return k + 2;
      } else {
        if (c === '\n') line++;
        k++;
      }
    }
    blank(from, k);
    return k;
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n') {
      line++;
      i++;
    } else if (c === '/' && n === '/') {
      let k = i;
      while (k < src.length && src[k] !== '\n') k++;
      commentLines.add(line);
      blank(i, k);
      i = k;
    } else if (c === '/' && n === '*') {
      let k = src.indexOf('*/', i + 2);
      k = k < 0 ? src.length : k + 2;
      for (let j = i; j < k; j++) if (src[j] === '\n') line++;
      commentLines.add(line);
      blank(i, k);
      i = k;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < src.length && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(k, src.length));
      i = k + 1;
      prev = c;
    } else if (c === '`') {
      i = template(i + 1);
      prev = '`';
    } else if (c === '/' && (prev === '' || REGEX_PREV.has(prev))) {
      let k = i + 1;
      let inClass = false;
      while (k < src.length && src[k] !== '\n' && (inClass || src[k] !== '/')) {
        if (src[k] === '\\') k++;
        else if (src[k] === '[') inClass = true;
        else if (src[k] === ']') inClass = false;
        k++;
      }
      if (src[k] === '/') {
        blank(i + 1, k);
        i = k + 1;
        prev = '/';
      } else i++;
    } else {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (templateAt.length && templateAt[templateAt.length - 1] === depth) {
          templateAt.pop();
          out[i] = ' ';
          i = template(i + 1);
          prev = '`';
          continue;
        }
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return { masked: out.join(''), commentLines };
}

const OPEN = '([{';
const CLOSE = ')]}';

/** Index of the bracket closing the one at `open`, or -1. */
function matchClose(m, open) {
  let d = 0;
  for (let k = open; k < m.length; k++) {
    if (OPEN.includes(m[k])) d++;
    else if (CLOSE.includes(m[k]) && --d === 0) return k;
  }
  return -1;
}

/** [start, end) ranges of the top-level arguments between the parentheses at open and close. */
function splitArgs(m, open, close) {
  const ranges = [];
  let d = 0;
  let from = open + 1;
  for (let k = open + 1; k < close; k++) {
    if (OPEN.includes(m[k])) d++;
    else if (CLOSE.includes(m[k])) d--;
    else if (m[k] === ',' && d === 0) {
      ranges.push([from, k]);
      from = k + 1;
    }
  }
  if (m.slice(from, close).trim()) ranges.push([from, close]);
  return ranges;
}

const LIT = String.raw`(?:-?\d+(?:\.\d+)?|'[^'\n]*'|"[^"\n]*"|true|false|null|undefined)`;
const LITERAL = new RegExp(`^${LIT}$`);
const EXPECT_SAME = new RegExp(String.raw`\bexpect\s*\(\s*(${LIT})\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*(${LIT})\s*\)`, 'g');
const ASSERT_SAME = /\b(?:t\.)?assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/g;
const ASSERT_TRUE = /\b(?:t\.)?assert(?:\.ok)?\s*\(\s*true\s*[,)]/g;
const EXPECT_TRUTHY = /\bexpect\s*\(\s*true\s*\)\s*\.\s*toBeTruthy\s*\(\s*\)/g;
const TEST_CALL = /\b(test|it|xit|xtest)(?:\.(only|skip|todo))?\s*\(/g;
const ONLY_OPTION = /\bonly\s*:\s*true\b/g;

export function findVacuous(src, { assertNames = [] } = {}) {
  const { masked, commentLines } = mask(src);
  const starts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const found = [];
  const add = (idx, reason) => found.push({ line: lineOf(idx), reason });
  const code = (idx) => masked[idx] === src[idx]; // false when the match began inside a comment or string

  const names = ['assert', 'expect', 'should', ...assertNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))];
  const ASSERTION = new RegExp(`\\b(?:${names.join('|')})`);

  // A helper defined in this file whose body asserts counts as an assertion when a test calls it.
  // Repeats until no new helper turns up, so a helper that calls another helper works too.
  const candidates = [];
  for (const m of masked.matchAll(/\bfunction\s*\*?\s*(\w+)\s*\(/g)) {
    const close = matchClose(masked, m.index + m[0].length - 1);
    const brace = close < 0 ? -1 : masked.indexOf('{', close);
    const end = brace < 0 ? -1 : matchClose(masked, brace);
    if (end > 0) candidates.push([m[1], masked.slice(brace, end + 1)]);
  }
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*/g)) {
    const at = m.index + m[0].length;
    const end = masked[at] === '{' ? matchClose(masked, at) + 1 : masked.indexOf('\n', at);
    candidates.push([m[1], masked.slice(at, end > at ? end : masked.length)]);
  }
  const helpers = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    const calls = new RegExp(`\\b(?:${[...helpers].join('|') || '(?!)'})\\s*\\(`);
    for (const [name, body] of candidates) {
      if (!helpers.has(name) && (ASSERTION.test(body) || calls.test(body))) {
        helpers.add(name);
        grew = true;
      }
    }
  }
  const HELPER_CALL = new RegExp(`\\b(?:${[...helpers].join('|') || '(?!)'})\\s*\\(`);

  for (const m of masked.matchAll(TEST_CALL)) {
    const before = masked.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s*\*?\s*$/.test(before) || before.endsWith('.')) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close < 0) continue;
    const args = masked.slice(open, close + 1);
    const mod = m[2] || (m[1].startsWith('x') ? 'skip' : '');

    if (mod === 'only') add(m.index, 'leftover .only runs just this test and hides the rest of the file');
    if (mod === 'skip') {
      const ranges = splitArgs(masked, open, close);
      const stringArg = ranges.slice(1).some(([a, b]) => /^\s*["'`]/.test(src.slice(a, b)));
      const line = lineOf(m.index);
      if (!stringArg && !commentLines.has(line) && !commentLines.has(line - 1)) {
        add(m.index, 'skipped test with no reason; add a reason string or a comment');
      }
    }
    if (mod === 'skip' || mod === 'todo') continue;
    if (!/=>|\bfunction\b/.test(args)) continue; // no inline callback to look inside
    if (!ASSERTION.test(args) && !HELPER_CALL.test(args)) add(m.index, 'test body has no assertion, so it cannot fail');
  }

  for (const m of masked.matchAll(ONLY_OPTION)) add(m.index, 'leftover only: true runs just this test and hides the rest of the file');
  for (const m of masked.matchAll(ASSERT_TRUE)) add(m.index, 'assert.ok(true) always passes');
  for (const m of masked.matchAll(EXPECT_TRUTHY)) add(m.index, 'expect(true).toBeTruthy() always passes');

  for (const m of src.matchAll(EXPECT_SAME)) {
    if (code(m.index) && m[1] === m[2]) add(m.index, `both sides are the literal ${m[1]}, so the check always passes`);
  }
  for (const m of masked.matchAll(ASSERT_SAME)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close < 0) continue;
    const args = splitArgs(masked, open, close).map(([a, b]) => src.slice(a, b).trim());
    if (args.length >= 2 && LITERAL.test(args[0]) && args[0] === args[1]) {
      add(m.index, `both sides are the literal ${args[0]}, so the check always passes`);
    }
  }

  for (const m of masked.matchAll(/\bexpect\s*\(/g)) {
    if (masked[m.index - 1] === '.') continue;
    const close = matchClose(masked, m.index + m[0].length - 1);
    if (close < 0) continue;
    if (!/^\s*\./.test(masked.slice(close + 1, close + 40))) add(m.index, 'expect(...) has no matcher, so nothing is checked');
  }

  return found.sort((a, b) => a.line - b.line);
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DEFAULT_DIRS = ['test', 'tests', '__tests__', 'spec'];
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(target, out, explicit) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (explicit || TEST_FILE.test(target)) out.push(target);
    return;
  }
  for (const name of fs.readdirSync(target).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(target, name);
    if (fs.statSync(full).isDirectory()) walk(full, out, false);
    else if (TEST_FILE.test(name)) out.push(full);
  }
}

/** Scans files or folders; returns [{ file, line, reason }]. */
export function scanPaths(targets, opts = {}) {
  const files = [];
  for (const t of targets) walk(t, files, true);
  const results = [];
  for (const file of files) {
    for (const f of findVacuous(fs.readFileSync(file, 'utf8'), opts)) {
      results.push({ file: file.replace(/\\/g, '/'), ...f });
    }
  }
  return results;
}

if (isMain(import.meta.url)) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: { json: { type: 'boolean' }, 'assert-name': { type: 'string', multiple: true } },
    }));
    const targets = positionals.length ? positionals : DEFAULT_DIRS.filter((d) => fs.existsSync(d));
    for (const t of targets) if (!fs.existsSync(t)) throw new Error(`${t} does not exist`);
    const results = scanPaths(targets, { assertNames: values['assert-name'] || [] });
    if (values.json) console.log(JSON.stringify(results, null, 2));
    else for (const r of results) console.log(`${r.file}:${r.line}: ${r.reason}`);
    process.exit(results.length ? 1 : 0);
  } catch (err) {
    console.error(`find-vacuous-tests: ${err.message}`);
    console.error('Usage: find-vacuous-tests [files or folders] [--assert-name <name>] [--json]');
    process.exit(2);
  }
}
