#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';
import { HOOKS, buildHooks } from '../lib/hook-table.mjs';

const checkout = path.resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\\/g, '/');

const commandsIn = (groups) => groups.flatMap((g) => (Array.isArray(g.hooks) ? g.hooks.map((h) => h.command) : []));

/**
 * Adds the named hooks to settings (an object) and returns { settings, added }, where added lists
 * "name (Event matcher)" for each new entry. Everything already in settings is kept.
 * Throws when the hooks section is not shaped the way Claude Code expects.
 */
export function mergeHooks(settings, names = HOOKS.map((h) => h.name), dir = checkout) {
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error('"hooks" is not an object');
  }
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  const added = [];
  for (const h of HOOKS.filter((x) => names.includes(x.name))) {
    for (const [event, matcher] of h.on) {
      if (next.hooks[event] !== undefined && !Array.isArray(next.hooks[event])) throw new Error(`hooks.${event} is not a list`);
      const groups = next.hooks[event] || [];
      const [entry] = buildHooks(dir, [h.name])[event].filter((g) => (g.matcher || '') === matcher);
      if (commandsIn(groups).includes(entry.hooks[0].command)) continue;
      next.hooks[event] = [...groups, entry];
      added.push(`${h.name} (${event}${matcher ? ` ${matcher}` : ''})`);
    }
  }
  return { settings: next, added };
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { project: { type: 'string' }, only: { type: 'string' }, 'dry-run': { type: 'boolean' } } }));
    if (!values.project) throw new Error('--project is required');
  } catch (err) {
    console.error(err.message);
    console.error('Usage: setup --project <path> [--only name,name] [--dry-run]');
    return 2;
  }
  const known = HOOKS.map((h) => h.name);
  const names = values.only ? values.only.split(',').map((n) => n.trim()).filter(Boolean) : known;
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length || names.length === 0) {
    console.error(`Unknown hook: ${unknown.join(', ') || '(none given)'}. Available: ${known.join(', ')}`);
    return 2;
  }
  const project = path.resolve(values.project);
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
    console.error(`${project} is not a folder`);
    return 2;
  }
  const file = path.join(project, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Error('the top level is not an object');
    } catch (err) {
      console.error(`${file} is damaged (${err.message}). Fix it by hand; nothing was changed.`);
      return 2;
    }
  }
  let merged;
  try {
    merged = mergeHooks(settings, names);
  } catch (err) {
    console.error(`${file} is damaged (${err.message}). Fix it by hand; nothing was changed.`);
    return 2;
  }
  if (merged.added.length === 0) {
    console.log('Nothing to add; every selected hook is already in place.');
    return 0;
  }
  if (!values['dry-run']) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged.settings, null, 2) + '\n');
  }
  for (const a of merged.added) console.log(`${values['dry-run'] ? 'would add' : 'added'} ${a}`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
