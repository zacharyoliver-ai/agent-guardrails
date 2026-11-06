#!/usr/bin/env node
import { isMain, run } from '../lib/hook-io.mjs';

const OFF_LIMITS_DIR = /(^|\/)(api|server|db|migrations|scripts|test|tests)\//;
const TEST_FILE = /\.(test|spec)\./;
const BLOCKED_COMMAND = /\bgit\s+push\b|\bgh\s+pr\b|\bnpm\s+(run\s+)?test\b|\bnode\s+--test\b|\bplaywright\s+test\b/;

/** Returns a deny reason, or null to allow. */
export function checkSeat(input, env = process.env) {
  if (env.GUARDRAILS_SEAT !== 'design') return null;
  const ti = input.tool_input || {};
  if (input.tool_name === 'Edit' || input.tool_name === 'Write') {
    const p = String(ti.file_path || '').replace(/\\/g, '/');
    if (OFF_LIMITS_DIR.test(p) || TEST_FILE.test(p.split('/').pop())) {
      return `The design seat edits screens only. ${p} belongs to the backend or the tests; hand it to the agent that owns it.`;
    }
  }
  if (input.tool_name === 'Bash' && BLOCKED_COMMAND.test(String(ti.command || ''))) {
    return 'The design seat does not push, open pull requests or run tests. Leave that to the builder and report what changed.';
  }
  return null;
}

if (isMain(import.meta.url)) await run('design-seat', (input) => checkSeat(input));
