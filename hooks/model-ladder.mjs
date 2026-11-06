#!/usr/bin/env node
import fs from 'node:fs';
import { isMain, run } from '../lib/hook-io.mjs';

const DEFAULTS = {
  tiers: { cheap: ['haiku'], standard: ['sonnet'], expensive: ['opus'] },
  expensiveJobs: ['review', 'security', 'migration', 'legal', 'architecture', 'audit'],
  lookupWords: ['find', 'locate', 'list', 'count', 'look up', 'lookup', 'where is', 'search for'],
  buildWords: ['build', 'implement', 'fix', 'write', 'refactor', 'add', 'create'],
};

/** Defaults, with any keys from the JSON file named by GUARDRAILS_LADDER laid over them. */
export function loadConfig(env = process.env) {
  const file = env.GUARDRAILS_LADDER;
  if (!file) return DEFAULTS;
  try {
    const user = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('not an object');
    return {
      ...DEFAULTS,
      ...Object.fromEntries(Object.keys(DEFAULTS).filter((k) => user[k] !== undefined).map((k) => [k, user[k]])),
    };
  } catch (err) {
    process.stderr.write(`model-ladder: could not read ${file} (${err.message}), using defaults\n`);
    return DEFAULTS;
  }
}

// Whole words only, so "listen" is not "list" and "account" is not "count".
function hasWord(text, words) {
  return words.some((w) => {
    const body = String(w).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i').test(text);
  });
}

function tierOf(model, tiers) {
  const m = model.toLowerCase();
  for (const [tier, names] of Object.entries(tiers)) {
    if (names.some((n) => m.includes(String(n).toLowerCase()))) return tier;
  }
  return null;
}

/** Returns a deny reason for an Agent or Task call that picks the wrong model, or null. */
export function checkLadder(input, env = process.env) {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return null;
  const cfg = loadConfig(env);
  const ti = input.tool_input || {};
  const model = String(ti.model || '').trim();
  const cheap = cfg.tiers.cheap?.[0] || 'haiku';
  const standard = cfg.tiers.standard?.[0] || 'sonnet';
  const expensive = cfg.tiers.expensive?.[0] || 'opus';
  if (!model) {
    return `Name a model for this subagent. Use "${cheap}" for lookups, "${standard}" for building and fixing, and "${expensive}" only for ${cfg.expensiveJobs.join(', ')}.`;
  }
  const tier = tierOf(model, cfg.tiers);
  if (!tier) return null;
  const text = String(ti.description || '');
  const review = hasWord(text, ['review', 'audit']);
  if (tier === 'cheap') {
    return review ? `A review needs a stronger model than "${model}". Retry with "${expensive}".` : null;
  }
  if (tier === 'expensive' && !hasWord(text, cfg.expensiveJobs)) {
    return `"${model}" is reserved for ${cfg.expensiveJobs.join(', ')}. Retry with "${standard}", or with "${cheap}" if this is only a lookup.`;
  }
  if (!review && hasWord(text, cfg.lookupWords) && !hasWord(text, cfg.buildWords)) {
    return `This reads like a lookup, and "${model}" costs more than it needs to. Retry with "${cheap}".`;
  }
  return null;
}

if (isMain(import.meta.url)) await run('model-ladder', (input) => checkLadder(input));
