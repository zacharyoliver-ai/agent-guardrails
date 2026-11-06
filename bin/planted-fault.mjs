#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';

const DEFAULT_TIMEOUT_S = 120;

function runTest(cmd, cwd, timeoutS) {
  // A parent `node --test` sets this variable; a nested run would then print machine output.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // Known limit: on timeout only the shell is killed, so a test process it started can linger
  // until it exits on its own. Running the command in its own process group would end it too.
  return spawnSync(cmd, { shell: true, cwd, env, encoding: 'utf8', timeout: timeoutS * 1000 });
}

// A run that was killed (by the timeout or a signal) says nothing about the test, either way.
const cutShort = (r) => r.status === null || Boolean(r.error);

const tail = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-15).join('\n');

/** Returns { code, message }: 0 CAUGHT, 1 MISSED, 2 setup problem, 3 TIMEOUT. The file is always restored byte for byte. */
export function plantedFault({ file, find, replace, test, cwd = process.cwd(), timeout = DEFAULT_TIMEOUT_S }) {
  const original = fs.readFileSync(file);
  const text = original.toString('utf8');
  const timeoutMessage = `TIMEOUT: the test run was killed or ran past ${timeout} seconds, so the fault is neither caught nor missed`;

  // The limit is for a fault that hangs. A small one must not fail the clean run on a slow machine.
  const firstLimit = Math.max(timeout, DEFAULT_TIMEOUT_S);
  const first = runTest(test, cwd, firstLimit);
  if (cutShort(first)) return { code: 2, message: `The test run before the fault was killed or ran past ${firstLimit} seconds, so it proves nothing.` };
  if (first.status !== 0) {
    return { code: 2, message: `The test does not pass before the fault is planted, so it proves nothing.\n${tail(first)}` };
  }

  const parts = text.split(find);
  if (parts.length !== 2) {
    return { code: 2, message: `--find must match exactly once in ${file}; it matched ${parts.length - 1} times.` };
  }

  const restore = () => fs.writeFileSync(file, original);
  const quit = (number) => () => {
    restore();
    process.exit(128 + number);
  };
  const handlers = [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]].map(([s, n]) => [s, quit(n)]);
  for (const [s, h] of handlers) process.once(s, h);
  try {
    fs.writeFileSync(file, parts[0] + replace + parts[1]);
    const second = runTest(test, cwd, timeout);
    if (cutShort(second)) return { code: 3, message: timeoutMessage };
    return second.status === 0
      ? { code: 1, message: 'MISSED: the test still passes with the fault in place' }
      : { code: 0, message: 'CAUGHT: the test failed on the planted fault' };
  } finally {
    restore();
    for (const [s, h] of handlers) process.removeListener(s, h);
  }
}

if (isMain(import.meta.url)) {
  let values;
  try {
    ({ values } = parseArgs({
      options: { file: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, test: { type: 'string' }, timeout: { type: 'string' } },
    }));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const timeout = values.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(values.timeout);
  if ([values.file, values.find, values.replace, values.test].some((v) => v === undefined) || !values.find || !(timeout > 0)) {
    console.error('Usage: planted-fault --file <path> --find <text> --replace <text> --test "<command>" [--timeout <seconds>]');
    process.exit(2);
  }
  const { code, message } = plantedFault({ ...values, timeout });
  (code === 0 ? console.log : console.error)(message);
  process.exit(code === 3 ? 1 : code);
}
