import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from '../lib/hook-io.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const stateFile = () => path.join(tmpDir('ag-io-'), 'state.json');
const refuse = (code) => Object.assign(new Error(code), { code });

test('isMain holds for the script being run, through a symlinked folder too, and never for what it imports', () => {
  const base = tmpDir('ag-main-');
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'junction');
  const lib = new URL('../lib/hook-io.mjs', import.meta.url).href;
  fs.writeFileSync(path.join(real, 'other.mjs'), `import { isMain } from '${lib}';\nexport const other = isMain(import.meta.url);\n`);
  fs.writeFileSync(path.join(real, 'main.mjs'), `import { isMain } from '${lib}';\nimport { other } from './other.mjs';\nconsole.log(isMain(import.meta.url), other);\n`);
  for (const dir of [real, link]) {
    const r = spawnSync(process.execPath, [path.join(dir, 'main.mjs')], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'true false', `${dir}: ${r.stderr}`);
  }
});

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
