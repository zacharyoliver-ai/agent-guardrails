import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = new URL('../lib/temp-dirs.mjs', import.meta.url).href;
const testDir = fileURLToPath(new URL('.', import.meta.url));

function run(lastLine) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { tmpDir } from ${JSON.stringify(helper)};
    const dir = tmpDir('ag-temp-');
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
    console.log(JSON.stringify({ dir, there: fs.existsSync(path.join(dir, 'file.txt')) }));
    ${lastLine}
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return { status: r.status, ...JSON.parse(r.stdout) };
}

test('a temp folder is there while the process runs and gone once it exits', () => {
  const r = run('');
  assert.equal(r.status, 0);
  assert.equal(r.there, true);
  assert.equal(fs.existsSync(r.dir), false);
});

test('a temp folder is removed when the process fails too', () => {
  const r = run("throw new Error('a failing test file');");
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(r.dir), false);
});

test('every test file that makes a temp folder itself also removes it', () => {
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(files.length > 20);
  for (const f of files) {
    const text = fs.readFileSync(path.join(testDir, f), 'utf8');
    if (text.includes('mkdtempSync')) assert.ok(text.includes('rmSync'), `${f}: use tmpDir from lib/temp-dirs.mjs`);
  }
});
