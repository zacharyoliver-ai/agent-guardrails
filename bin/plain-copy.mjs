#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';

const APOS = "['’]";

// Words that show "leverage" is the noun ("some leverage", "leverage over a supplier").
const NOUN_BEFORE = new Set(['the', 'a', 'an', 'some', 'any', 'no', 'more', 'less', 'little', 'much', 'of', 'real', 'financial', 'political', 'its', 'our', 'their', 'his', 'her', 'your', 'my', 'have', 'has', 'had', 'gain', 'gains', 'gained', 'with', 'and']);
const NOUN_AFTER = new Set(['over', 'in', 'on', 'is', 'was', 'for', 'of', 'with', 'to', 'and', 'at', 'against']);

function leverageIsVerb(line, at, length) {
  const before = (line.slice(0, at).match(/([a-z]+)\W*$/i) || [])[1];
  const after = (line.slice(at + length).match(/^\W*([a-z]+)/i) || [])[1];
  if (/^leverag(?:ed|ing)$/i.test(line.slice(at, at + length))) return true;
  return !(before && NOUN_BEFORE.has(before.toLowerCase())) && !(after && NOUN_AFTER.has(after.toLowerCase()));
}

export const RULES = [
  { re: /\bseamless(?:ly)?\b/gi, suggest: 'say what works without a gap, for example "no downtime" or "one step"' },
  { re: /\bleverag(?:e|es|ed|ing)\b/gi, verb: leverageIsVerb, suggest: '"use"' },
  { re: /\bdelv(?:e|es|ed|ing)\b/gi, suggest: '"look at" or "dig into"' },
  { re: /\bunlock(?:s|ed|ing)? the power\b/gi, suggest: 'say what the reader can do now' },
  { re: /\bgame[- ]chang(?:ing|er)\b/gi, suggest: 'say what changed, with a number if there is one' },
  { re: /\bcutting[- ]edge\b/gi, suggest: '"new", or name the technique' },
  { re: new RegExp(`\\bin today${APOS}s fast[- ]paced\\b`, 'gi'), suggest: 'start with the point' },
  { re: /\belevate your\b/gi, suggest: '"improve your", or say what gets better' },
  { re: /\bempower(?:s|ed|ing|ment)?\b/gi, suggest: '"let", "help" or "give"' },
  { re: /\brobust(?:ly|ness)?\b/gi, suggest: 'name the property, such as "keeps working when input is bad"' },
  { re: /\bworld[- ]class\b/gi, suggest: 'say what it does better, and by how much' },
  { re: /\bbest[- ]in[- ]class\b/gi, suggest: 'say what it does better, and by how much' },
  { re: /\bsupercharg(?:e|es|ed|ing)\b/gi, suggest: '"speed up", or say by how much' },
  {
    re: new RegExp(`\\b(?:it|this|that|which)(?:${APOS}s| is)\\s+not\\b[^.!?\\n]{1,80}?[,;:—–-]+\\s*(?:it|this|that)(?:${APOS}s| is)\\b`, 'gi'),
    suggest: 'state the second half alone',
  },
  { re: /\bnot (?:just|only)\b[^.!?\n]{1,80}?,?\s+but\b(?: also)?/gi, suggest: 'say both things as plain statements' },
];

const FENCE = /^\s*(`{3,}|~{3,})/;
const EXTENSIONS = new Set(['.md', '.mdx', '.html', '.jsx', '.tsx']);
const MARKDOWN = new Set(['.md', '.mdx']);

/** Findings for one text: [{ line, phrase, suggest }]. Fenced code is skipped. */
export function findPlain(text, { add = [], allow = [], markdown = true } = {}) {
  const rules = [...RULES, ...add.map((r) => ({ re: new RegExp(r, 'gi'), suggest: 'rewrite it in plain words' }))];
  const allowed = allow.map((w) => w.toLowerCase());
  const found = [];
  let fence = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const f = markdown && FENCE.exec(raw);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return;
    }
    if (f) {
      fence = f[1];
      return;
    }
    const line = markdown ? raw.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length)) : raw;
    for (const rule of rules) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.verb && !rule.verb(line, m.index, m[0].length)) continue;
        if (allowed.some((w) => m[0].toLowerCase().includes(w))) continue;
        found.push({ line: i + 1, phrase: m[0], suggest: rule.suggest });
      }
    }
  });
  return found.sort((a, b) => a.line - b.line);
}

function walk(target, out) {
  if (fs.statSync(target).isFile()) return [...out, target];
  for (const name of fs.readdirSync(target).sort()) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(target, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(name).toLowerCase())) out.push(full);
  }
  return out;
  return out;
}

/** Scans files or folders; returns [{ file, line, phrase, suggest }]. */
export function scanPaths(targets, opts = {}) {
  const results = [];
  for (const file of targets.flatMap((t) => walk(t, []))) {
    const markdown = MARKDOWN.has(path.extname(file).toLowerCase());
    for (const f of findPlain(fs.readFileSync(file, 'utf8'), { ...opts, markdown })) {
      results.push({ file: file.replace(/\\/g, '/'), ...f });
    }
  }
  return results;
}

if (isMain(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { json: { type: 'boolean' }, add: { type: 'string', multiple: true }, allow: { type: 'string', multiple: true } },
    });
    if (positionals.length === 0) throw new Error('give at least one file or folder');
    for (const p of positionals) if (!fs.existsSync(p)) throw new Error(`${p} does not exist`);
    for (const r of values.add || []) new RegExp(r); // a bad pattern is a usage error
    const results = scanPaths(positionals, { add: values.add || [], allow: values.allow || [] });
    if (values.json) console.log(JSON.stringify(results, null, 2));
    else for (const r of results) console.log(`${r.file}:${r.line}: "${r.phrase}" reads as machine-written. Try ${r.suggest}.`);
    process.exit(results.length ? 1 : 0);
  } catch (err) {
    console.error(`plain-copy: ${err.message}`);
    console.error('Usage: plain-copy <files or folders> [--add <regex>] [--allow <word>] [--json]');
    process.exit(2);
  }
}
