import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from '../lib/hook-io.mjs';

const stateFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-io-')), 'state.json');
const refuse = (code) => Object.assign(new Error(code), { code });

test('writeAtomic replaces the file and leaves no temporary file', () => {
  const file = stateFile();
  fs.writeFileSync(file, 'old');
  writeAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

test('a rename refused for a moment is tried again', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const file = stateFile();
    let calls = 0;
    writeAtomic(file, 'new', (from, to) => {
      if (++calls < 3) throw refuse(code);
      fs.renameSync(from, to);
    });
    assert.equal(calls, 3, code);
    assert.equal(fs.readFileSync(file, 'utf8'), 'new', code);
  }
});

test('a rename that keeps failing gives up, throws and removes its temporary file', () => {
  const file = stateFile();
  let calls = 0;
  const rename = () => {
    calls++;
    throw refuse('EPERM');
  };
  assert.throws(() => writeAtomic(file, 'new', rename), /EPERM/);
  assert.equal(calls, 20);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});

test('any other error is not tried again', () => {
  const file = stateFile();
  let calls = 0;
  const rename = () => {
    calls++;
    throw refuse('ENOSPC');
  };
  assert.throws(() => writeAtomic(file, 'new', rename), /ENOSPC/);
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});
