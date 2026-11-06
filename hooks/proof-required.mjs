#!/usr/bin/env node
import { isMain } from '../lib/hook-io.mjs';
import { finalText, runStop, turnLines } from '../lib/stop-io.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const DEFAULT_CHECKS = String.raw`\b(test|spec|vitest|jest|pytest|go test|cargo test|playwright|eslint|tsc)\b`;
const CLAIM = /\b(done|fixed|works|working|passes|passing|complete|completed|finished|resolved)\b/i;
const DISCLAIMER = /\b(not verified|unverified|did not run|didn't run|didn’t run)\b/i;

/** Tool calls of the current turn, in order. */
function toolCalls(input) {
  const calls = [];
  for (const line of turnLines(input)) {
    if (line.type !== 'assistant' || !Array.isArray(line.message?.content)) continue;
    for (const b of line.message.content) if (b?.type === 'tool_use') calls.push(b);
  }
  return calls;
}

/** Returns a reason when the message claims completion but an edit has no check after it. */
export function checkProof(input, env = process.env) {
  const text = finalText(input);
  if (!text || !CLAIM.test(text) || DISCLAIMER.test(text)) return null;

  const calls = toolCalls(input);
  let last = -1;
  calls.forEach((c, i) => {
    if (EDIT_TOOLS.has(c.name)) last = i;
  });
  if (last < 0) return null;

  const isCheck = new RegExp(env.GUARDRAILS_PROOF_COMMANDS || DEFAULT_CHECKS, 'i');
  const checked = calls.slice(last + 1).some((c) => c.name === 'Bash' && isCheck.test(String(c.input?.command || '')));
  if (checked) return null;

  const file = calls[last].input?.file_path || calls[last].input?.notebook_path || 'a file';
  return `You say the work is done, but ${file} was edited and no check ran after that edit. Run the tests or linter that cover it and report the result, or say plainly that the change was not verified.`;
}

if (isMain(import.meta.url)) await runStop('proof-required', (input) => checkProof(input));
