#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/hook-io.mjs';
import { finalText, runStop } from '../lib/stop-io.mjs';

/** The message without fenced code blocks and blockquote lines, which quote other text. */
export function prose(text) {
  let fenced = false;
  const keep = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && !/^\s*>/.test(line)) keep.push(line);
  }
  return keep.join('\n');
}

function loadRules(input, env) {
  const file = env.GUARDRAILS_NEVER_SAY || path.join(input.cwd || process.cwd(), 'never-say.json');
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  return Array.isArray(list) ? list : [];
}

/** Returns a reason naming the first listed line the final message contains, or null. */
export function checkNeverSay(input, env = process.env) {
  const text = prose(finalText(input));
  if (!text) return null;
  for (const rule of loadRules(input, env)) {
    let re;
    try {
      re = new RegExp(rule.pattern, rule.flags || '');
    } catch {
      process.stderr.write(`never-say: skipping bad pattern ${JSON.stringify(rule.pattern)}\n`);
      continue;
    }
    const m = re.exec(text);
    if (!m || !m[0]) continue;
    const parts = [`Your reply contains "${m[0]}", which is on the never-say list.`];
    if (rule.why) parts.push(`Why: ${rule.why}`);
    if (rule.instead) parts.push(`Instead: ${rule.instead}`);
    parts.push('Rewrite the reply without it.');
    return parts.join(' ');
  }
  return null;
}

if (isMain(import.meta.url)) await runStop('never-say', (input) => checkNeverSay(input));
