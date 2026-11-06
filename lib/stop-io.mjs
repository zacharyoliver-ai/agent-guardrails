import fs from 'node:fs';
import { parseInput, readStdin } from './hook-io.mjs';

function readLines(file) {
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // a damaged line is skipped
    }
  }
  return out;
}

const blocks = (line) => (Array.isArray(line.message?.content) ? line.message.content : []);
const textOf = (line) => blocks(line).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');

/** The assistant's last message: the hook's own field, else the transcript's final text blocks. */
export function finalText(input) {
  if (typeof input.last_assistant_message === 'string' && input.last_assistant_message) return input.last_assistant_message;
  const lines = readLines(input.transcript_path).filter((l) => l.type === 'assistant');
  if (!lines.length) return '';
  const id = lines[lines.length - 1].message?.id;
  const same = id ? lines.filter((l) => l.message?.id === id) : [lines[lines.length - 1]];
  return same.map(textOf).filter(Boolean).join('\n');
}

/** True for a line the person typed: string content or a text block, never a tool result. */
function isPersonMessage(line) {
  if (line.type !== 'user') return false;
  const c = line.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b?.type === 'text');
}

/** Transcript lines after the last person message. */
export function turnLines(input) {
  const lines = readLines(input.transcript_path);
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isPersonMessage(lines[i])) {
      start = i + 1;
      break;
    }
  }
  return lines.slice(start);
}

export function sendBack(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}

export function addContext(text) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) + '\n',
  );
}

/**
 * Shared Stop main: decide(input) returns a reason to send back, or null.
 * A second pass (stop_hook_active) always allows, so a reply goes back once.
 * Bad input or a thrown error allows and writes one stderr line.
 */
export async function runStop(name, decide) {
  try {
    const input = parseInput(await readStdin());
    if (!input) return void process.stderr.write(`${name}: could not parse hook input, allowing\n`);
    if (input.stop_hook_active === true) return;
    const reason = await decide(input);
    if (reason) sendBack(reason);
  } catch (err) {
    process.stderr.write(`${name}: ${err.message}, allowing\n`);
  }
}
