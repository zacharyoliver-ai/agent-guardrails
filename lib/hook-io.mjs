import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_TRIES = 20;

/**
 * Replaces a file whole, so a reader never sees half of it. Windows refuses a rename for a
 * moment while something like a virus scanner holds the file, so a refused rename is tried again.
 */
export function writeAtomic(file, text, rename = fs.renameSync) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let tries = 1; ; tries++) {
    try {
      return rename(tmp, file);
    } catch (err) {
      if (tries >= RENAME_TRIES || !BUSY.has(err.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * tries); // a pause in sync code
    }
  }
}

export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Parse hook stdin; returns an object or null when it is not a JSON object. */
export function parseInput(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function denyJson(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

export function allow() {}

export function deny(reason) {
  process.stdout.write(denyJson(reason) + '\n');
}

/** True when the module at metaUrl is the script being executed. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl));
}

/**
 * Shared main: read stdin, call decide(input) -> reason string or null.
 * Malformed input or a thrown error allows the call and writes one stderr line.
 */
export async function run(name, decide) {
  try {
    const input = parseInput(await readStdin());
    if (!input) return void process.stderr.write(`${name}: could not parse hook input, allowing\n`);
    const reason = decide(input);
    if (reason) deny(reason);
  } catch (err) {
    process.stderr.write(`${name}: ${err.message}, allowing\n`);
  }
}

/** Glob to RegExp. `*` matches within a segment, `**` matches across segments. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(glob, filePath) {
  return globToRegExp(glob).test(filePath);
}
