#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isMain, matchGlob, run } from '../lib/hook-io.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

const slashes = (p) => String(p).replace(/\\/g, '/');
const isAbsolute = (p) => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

/** Returns the path relative to cwd, or null when it lands outside cwd. */
export function relativeToCwd(target, cwd) {
  const base = path.posix.normalize(slashes(cwd)).replace(/\/$/, '');
  const t = slashes(target);
  const abs = path.posix.normalize(isAbsolute(t) ? t : `${base}/${t}`);
  const windows = /^[A-Za-z]:/.test(base);
  const a = windows ? abs.toLowerCase() : abs;
  const b = windows ? base.toLowerCase() : base;
  return a.startsWith(`${b}/`) ? abs.slice(base.length + 1) : null;
}

/** Returns a deny reason, or null to allow. */
export function checkOwnership(input, env = process.env) {
  if (!EDIT_TOOLS.has(input.tool_name)) return null;
  const lane = env.GUARDRAILS_LANE;
  if (!lane) return null;
  const cwd = input.cwd || process.cwd();
  const ownersFile = path.join(cwd, '.guardrails', 'owners.json');
  if (!fs.existsSync(ownersFile)) return null;

  const owners = JSON.parse(fs.readFileSync(ownersFile, 'utf8'));
  const globs = owners.lanes && owners.lanes[lane];
  const target = input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path);
  if (!target) return null;

  const rel = relativeToCwd(target, cwd);
  if (rel === null) return `Lane "${lane}" may not edit ${slashes(target)}: it is outside the project folder.`;
  if (!Array.isArray(globs)) return `Lane "${lane}" is not defined in .guardrails/owners.json, so it owns no files.`;
  if (globs.some((g) => matchGlob(g, rel))) return null;
  return `Lane "${lane}" does not own ${rel}. Its files: ${globs.join(', ')}. Ask the agent that owns this path, or stay in your lane.`;
}

if (isMain(import.meta.url)) await run('file-ownership', (input) => checkOwnership(input));
