import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findPlain, scanPaths } from '../bin/plain-copy.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const script = fileURLToPath(new URL('../bin/plain-copy.mjs', import.meta.url));
const phrases = (text, opts) => findPlain(text, opts).map((f) => f.phrase.toLowerCase());

test('each built-in phrase is found', () => {
  const samples = {
    seamless: 'A seamless setup.',
    seamlessly: 'It works seamlessly.',
    delve: "Let's delve into it.",
    'unlock the power': 'Unlock the power of data.',
    'game-changing': 'A game-changing tool.',
    'cutting-edge': 'Cutting edge models.',
    "in today's fast-paced": "In today's fast-paced world, we ship.",
    'elevate your': 'Elevate your workflow.',
    empower: 'We empower teams.',
    robust: 'A robust parser.',
    'world-class': 'World-class support.',
    'best-in-class': 'Best in class speed.',
    supercharge: 'Supercharge your day.',
  };
  for (const [phrase, text] of Object.entries(samples)) {
    assert.equal(findPlain(text).length, 1, phrase);
    assert.ok(phrases(text)[0].replace(/[-' ]/g, '').startsWith(phrase.replace(/[-' ]/g, '').slice(0, 5)), phrase);
  }
});

test('a finding names the line, the phrase and a plain alternative', () => {
  const out = findPlain('First line.\nThis is robust code.\n');
  assert.deepEqual(out.map((f) => [f.line, f.phrase]), [[2, 'robust']]);
  assert.ok(out[0].suggest.length > 10);
});

test('leverage is flagged as a verb and left alone as a noun', () => {
  assert.equal(findPlain('We leverage the cache.').length, 1);
  assert.equal(findPlain('Leveraging our data helps.').length, 1);
  assert.equal(findPlain('They have leverage over the supplier.').length, 0);
  assert.equal(findPlain('Financial leverage is risky.').length, 0);
  assert.equal(findPlain('It gives us some leverage.').length, 0);
});

test('it is not X, it is Y and not just X, but Y are flagged', () => {
  assert.equal(findPlain("It's not a toolkit, it's a mindset.").length, 1);
  assert.equal(findPlain('This is not a plugin; this is a platform.').length, 1);
  assert.equal(findPlain('Not just fast, but also safe.').length, 1);
  assert.equal(findPlain('It is not only quick but reliable.').length, 1);
  assert.equal(findPlain("It's not working yet. It's on the list.").length, 0);
  assert.equal(findPlain('Not all tests pass, but most do.').length, 0);
});

test('fenced code and inline code are skipped in markdown', () => {
  const md = ['Plain text.', '```js', 'const robust = 1;', '```', 'Inline `robust` is fine.', '~~~', 'seamless', '~~~', 'This robust line is not.'].join('\n');
  assert.deepEqual(findPlain(md).map((f) => f.line), [9]);
});

test('a longer fence is not closed by a shorter one', () => {
  const md = ['````', '```', 'robust', '````', 'robust'].join('\n');
  assert.deepEqual(findPlain(md).map((f) => f.line), [5]);
});

test('--add and --allow adjust the list', () => {
  assert.equal(findPlain('A synergy of parts.').length, 0);
  assert.equal(findPlain('A synergy of parts.', { add: ['synerg\\w+'] }).length, 1);
  assert.equal(findPlain('A robust parser.', { allow: ['robust'] }).length, 0);
  assert.equal(findPlain('A robust parser and a seamless one.', { allow: ['robust'] }).length, 1);
});

test('html and jsx are scanned whole, folders are walked, other files and node_modules are skipped', () => {
  const dir = tmpDir('ag-plain-');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'a.html'), '<p>A seamless thing</p>\n');
  fs.writeFileSync(path.join(dir, 'b.tsx'), 'export default () => <p>We empower you</p>;\n');
  fs.writeFileSync(path.join(dir, 'c.md'), 'robust\n');
  fs.writeFileSync(path.join(dir, 'd.txt'), 'robust\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'e.md'), 'robust\n');
  const out = scanPaths([dir]).map((f) => path.basename(f.file));
  assert.deepEqual(out.sort(), ['a.html', 'b.tsx', 'c.md']);
});

test('cli: exit 1 with file:line, 0 when clean, 2 on bad usage', () => {
  const dir = tmpDir('ag-plain-');
  const file = path.join(dir, 'a.md');
  fs.writeFileSync(file, 'We build it.\nIt is seamless.\n');
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /a\.md:2: "seamless" reads as machine-written/);
  assert.equal(JSON.parse(spawnSync(process.execPath, [script, file, '--json'], { encoding: 'utf8' }).stdout)[0].line, 2);
  assert.equal(spawnSync(process.execPath, [script, file, '--allow', 'seamless'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, path.join(dir, 'none')], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, file, '--add', '('], { encoding: 'utf8' }).status, 2);
});
