#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain, run } from '../lib/hook-io.mjs';

const READ_ONLY = new Set(['Read', 'Grep', 'Glob']);

export function stateDir(env = process.env) {
  return env.GUARDRAILS_STATE_DIR || path.join(os.tmpdir(), 'agent-guardrails');
}

/** Counts this call. Returns a deny reason, or null to allow. */
export function checkStep(input, env = process.env) {
  const warn = Number(env.GUARDRAILS_STEP_WARN) || 120;
  const limit = Number(env.GUARDRAILS_STEP_LIMIT) || 150;
  const key = String(input.agent_id || input.session_id || 'unknown').replace(/[^\w-]/g, '_');
  const dir = stateDir(env);
  const file = path.join(dir, `${key}.json`);

  let state = { count: 0, warned: false };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // missing or damaged counter: start again from zero
  }
  state.count += 1;

  let reason = null;
  if (state.count > limit) {
    if (!READ_ONLY.has(input.tool_name)) {
      reason = `Step limit reached (${limit} tool calls). Only Read, Grep and Glob are allowed now. Stop and report what is done and what is left.`;
    }
  } else if (state.count > warn && !state.warned) {
    state.warned = true;
    reason = `You have used ${state.count - 1} of ${limit} tool calls. Write a hand-off note now: what is finished, what is left, and where the files are. Then retry; this warning appears once.`;
  }

  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
  return reason;
}

if (isMain(import.meta.url)) await run('step-budget', (input) => checkStep(input));
