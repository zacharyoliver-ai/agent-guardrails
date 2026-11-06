#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';

function runTest(cmd, cwd) {
  // A parent `node --test` sets this variable; a nested run would then print machine output.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(cmd, { shell: true, cwd, env, encoding: 'utf8' });
}

const tail = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-15).join('\n');

/** Returns { code, message }. The file is always restored byte for byte. */
export function plantedFault({ file, find, replace, test, cwd = process.cwd() }) {
  const original = fs.readFileSync(file);
  const text = original.toString('utf8');

  const first = runTest(test, cwd);
  if (first.status !== 0) {
    return { code: 2, message: `The test does not pass before the fault is planted, so it proves nothing.\n${tail(first)}` };
  }

  const parts = text.split(find);
  if (parts.length !== 2) {
    return { code: 2, message: `--find must match exactly once in ${file}; it matched ${parts.length - 1} times.` };
  }

  const restore = () => fs.writeFileSync(file, original);
  const onSigint = () => {
    restore();
    process.exit(130);
  };
  process.once('SIGINT', onSigint);
  try {
    fs.writeFileSync(file, parts[0] + replace + parts[1]);
    const second = runTest(test, cwd);
    return second.status === 0
      ? { code: 1, message: 'MISSED: the test still passes with the fault in place' }
      : { code: 0, message: 'CAUGHT: the test failed on the planted fault' };
  } finally {
    restore();
    process.removeListener('SIGINT', onSigint);
  }
}

if (isMain(import.meta.url)) {
  let values;
  try {
    ({ values } = parseArgs({
      options: { file: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, test: { type: 'string' } },
    }));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if ([values.file, values.find, values.replace, values.test].some((v) => v === undefined) || !values.find) {
    console.error('Usage: planted-fault --file <path> --find <text> --replace <text> --test "<command>"');
    process.exit(2);
  }
  const { code, message } = plantedFault(values);
  (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}
