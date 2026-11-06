#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isMain, run, writeAtomic } from '../lib/hook-io.mjs';
import { stateDir } from './step-budget.mjs';

function loadConfig(env) {
  const cfg = { expensive: ['opus'], expensiveCap: 3, otherCap: 10 };
  if (!env.GUARDRAILS_FLEET) return cfg;
  try {
    const user = JSON.parse(fs.readFileSync(env.GUARDRAILS_FLEET, 'utf8'));
    if (Array.isArray(user.expensive)) cfg.expensive = user.expensive;
    if (Number.isFinite(user.expensiveCap)) cfg.expensiveCap = user.expensiveCap;
    if (Number.isFinite(user.otherCap)) cfg.otherCap = user.otherCap;
  } catch (err) {
    process.stderr.write(`fleet-cap: could not read ${env.GUARDRAILS_FLEET} (${err.message}), using defaults\n`);
  }
  return cfg;
}

function readEntries(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v.filter((e) => e && Number.isFinite(e.startedAt)) : [];
  } catch {
    return []; // missing or damaged: start again from zero
  }
}

// Known limit: read-modify-write without a lock, so two hooks racing can miscount by one.
// A per-session lock file around the read and the write would close it.
function writeEntries(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(entries));
}

// A call recorded on PreToolUse may be denied by another hook and never start, so it holds
// its slot only this long unless SubagentStart confirms it.
const PENDING_MS = 60000;

/**
 * PreToolUse on Agent/Task: returns a deny reason when the tier is full, else records a pending
 * entry and returns null. SubagentStart turns the oldest matching pending entry into a running
 * one. SubagentStop frees one slot and returns null.
 */
export function checkFleet(input, env = process.env, now = Date.now()) {
  const event = input.hook_event_name;
  const stopping = event === 'SubagentStop';
  const starting = event === 'SubagentStart';
  if (!stopping && !starting && input.tool_name !== 'Agent' && input.tool_name !== 'Task') return null;

  const cfg = loadConfig(env);
  const ttl = (Number(env.GUARDRAILS_FLEET_TTL_MIN) || 120) * 60000;
  const key = String(input.session_id || 'unknown').replace(/[^\w-]/g, '_');
  const file = path.join(stateDir(env), `fleet-${key}.json`);
  const live = readEntries(file).filter((e) => now - e.startedAt < (e.state === 'pending' ? PENDING_MS : ttl));

  if (starting) {
    const pending = live.filter((e) => e.state === 'pending');
    const match = pending.find((e) => e.subagent_type === input.agent_type) || pending[0];
    if (match) {
      match.state = 'running';
      match.agent_id = input.agent_id;
      match.startedAt = now;
    }
    writeEntries(file, live);
    return null;
  }

  if (stopping) {
    let idx = input.agent_id ? live.findIndex((e) => e.agent_id === input.agent_id) : -1;
    if (idx < 0) idx = live.findIndex((e) => e.subagent_type === input.agent_type);
    live.splice(idx >= 0 ? idx : 0, 1); // entries are in start order, so index 0 is the oldest
    writeEntries(file, live);
    return null;
  }

  const ti = input.tool_input || {};
  const model = String(ti.model || '').toLowerCase();
  const tier = cfg.expensive.some((n) => model.includes(String(n).toLowerCase())) ? 'expensive' : 'other';
  const cap = tier === 'expensive' ? cfg.expensiveCap : cfg.otherCap;
  const running = live.filter((e) => e.tier === tier).length;
  if (running >= cap) {
    const hint = tier === 'expensive' ? ' Use a cheaper model for this one, or wait' : ' Wait';
    return `${running} ${tier === 'expensive' ? 'expensive-model' : 'other'} subagents are already running in this session (the cap is ${cap}).${hint} for one to finish, then retry.`;
  }
  live.push({ tool_use_id: input.tool_use_id, tier, subagent_type: ti.subagent_type, startedAt: now, state: 'pending' });
  writeEntries(file, live);
  return null;
}

if (isMain(import.meta.url)) await run('fleet-cap', (input) => checkFleet(input));
