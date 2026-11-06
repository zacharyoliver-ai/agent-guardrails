import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findVacuous, mask, scanPaths } from '../bin/find-vacuous-tests.mjs';

const script = fileURLToPath(new URL('../bin/find-vacuous-tests.mjs', import.meta.url));
const ownTests = fileURLToPath(new URL('.', import.meta.url));
const reasons = (src, opts) => findVacuous(src, opts).map((f) => f.reason);
const lines = (src, opts) => findVacuous(src, opts).map((f) => f.line);

test('a test body with no assertion is flagged at its line', () => {
  const src = "import test from 'node:test';\n\ntest('does nothing', () => {\n  const x = 1;\n});\n";
  assert.deepEqual(lines(src), [3]);
  assert.match(reasons(src)[0], /no assertion/);
});

test('assert, expect and should bodies pass, including inside nested subtests', () => {
  assert.deepEqual(findVacuous("test('a', () => { assert.equal(f(), 2); });"), []);
  assert.deepEqual(findVacuous("it('a', async () => { expect(f()).toBe(2); });"), []);
  assert.deepEqual(findVacuous("it('a', () => { f().should.equal(2); });"), []);
  assert.deepEqual(findVacuous("test('a', async (t) => { await t.test('b', () => { assert.ok(f()); }); });"), []);
});

test('--assert-name teaches the scanner a custom assertion helper', () => {
  const src = "test('a', () => { checkEqual(f(), 2); });";
  assert.equal(findVacuous(src).length, 1);
  assert.deepEqual(findVacuous(src, { assertNames: ['checkEqual'] }), []);
});

test('the word assert inside a string or comment does not count as an assertion', () => {
  assert.equal(findVacuous("test('a', () => { const s = 'assert.ok(x)'; });").length, 1);
  assert.equal(findVacuous("test('a', () => { // assert.ok(x)\n});").length, 1);
});

test('braces inside strings, templates, comments and regexes do not end the body early', () => {
  const body = [
    "test('a', () => {",
    "  const s = '}';",
    '  const t = `}${ "}" }`;',
    '  // }',
    '  /* } */',
    '  const r = /\\}/;',
    '  assert.equal(s, t);',
    '});',
  ].join('\n');
  assert.deepEqual(findVacuous(body), []);
  assert.equal(findVacuous(body.replace('assert.equal(s, t);', '')).length, 1);
});

test('mask keeps length and newlines and blanks only non-code text', () => {
  const src = "a('x}y'); // c\n`t${b}`;";
  const { masked } = mask(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, 2);
  assert.ok(!masked.includes('}y'));
  assert.ok(masked.includes('b'));
});

test('assert.ok(true), assert(true) and expect(true) checks are flagged', () => {
  for (const line of ['assert.ok(true);', 'assert(true);', 'assert.ok(true, "msg");', 'expect(true).toBe(true);', 'expect(true).toBeTruthy();']) {
    const out = findVacuous(`test('a', () => { ${line} });`);
    assert.equal(out.length, 1, line);
    assert.match(out[0].reason, /always passes/);
  }
  assert.deepEqual(findVacuous("test('a', () => { assert.ok(isReady()); });"), []);
});

test('the same literal on both sides is flagged, different values are not', () => {
  assert.equal(findVacuous("test('a', () => { assert.equal(1, 1); });").length, 1);
  assert.equal(findVacuous("test('a', () => { assert.strictEqual('x', 'x'); });").length, 1);
  assert.equal(findVacuous("test('a', () => { expect(2).toBe(2); });").length, 1);
  assert.deepEqual(findVacuous("test('a', () => { assert.equal(1, 2); });"), []);
  assert.deepEqual(findVacuous("test('a', () => { assert.equal(f(1), f(1)); });"), []);
  assert.deepEqual(findVacuous("test('a', () => { assert.equal(x, x); });"), []);
});

test('a bare expect with no matcher is flagged; expect.extend and a matcher chain are not', () => {
  const bare = findVacuous("test('a', () => { expect(f()); });");
  assert.equal(bare.length, 1);
  assert.match(bare[0].reason, /no matcher/);
  assert.deepEqual(findVacuous("test('a', () => { expect(f(g(1))).toBe(2); });"), []);
  assert.deepEqual(findVacuous("test('a', async () => { await expect(p).rejects.toThrow(); });"), []);
});

test('a leftover .only is flagged in each spelling', () => {
  for (const src of ["test.only('a', () => { assert.ok(x); });", "it.only('a', () => { expect(x).toBe(1); });", "test('a', { only: true }, () => { assert.ok(x); });"]) {
    const out = findVacuous(src);
    assert.equal(out.length, 1, src);
    assert.match(out[0].reason, /only/);
  }
});

test('.skip needs a reason string or a comment', () => {
  assert.equal(findVacuous("test.skip('a', () => { assert.ok(x); });").length, 1);
  assert.equal(findVacuous("xit('a', () => {});").length, 1);
  assert.deepEqual(findVacuous("test.skip(isCi, 'flaky on the CI runner');"), []);
  assert.deepEqual(findVacuous("// waiting on the parser fix\ntest.skip('a', () => {});"), []);
  assert.deepEqual(findVacuous("test.skip('a', () => {}); // waiting on the parser fix"), []);
});

test('test.todo and tests with no inline callback are left alone', () => {
  assert.deepEqual(findVacuous("test.todo('later');\ntest('a', handler);"), []);
});

test('a function that merely has the name test, or a method named test, is not a test', () => {
  assert.deepEqual(findVacuous('function test(a) { return a; }\nre.test(x);\nt.test(y);'), []);
});

test('scanPaths walks folders by hand, picks only test files and skips node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-vac-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const bad = "test('a', () => {});\n";
  fs.writeFileSync(path.join(dir, 'sub', 'a.test.mjs'), bad);
  fs.writeFileSync(path.join(dir, 'node_modules', 'b.test.mjs'), bad);
  fs.writeFileSync(path.join(dir, 'plain.mjs'), bad);
  const out = scanPaths([dir]);
  assert.equal(out.length, 1);
  assert.match(out[0].file, /sub\/a\.test\.mjs$/);
  assert.equal(out[0].line, 1);
  assert.equal(scanPaths([path.join(dir, 'plain.mjs')]).length, 1); // a named file is always scanned
});

test('cli: exit 1 with file:line, 0 when clean, 2 on a missing path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-vac-'));
  const file = path.join(dir, 'x.test.mjs');
  fs.writeFileSync(file, "test('a', () => {});\n");
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /x\.test\.mjs:1: test body has no assertion/);
  const j = spawnSync(process.execPath, [script, file, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(j.stdout)[0].line, 1);
  fs.writeFileSync(file, "test('a', () => { assert.ok(x); });\n");
  assert.equal(spawnSync(process.execPath, [script, file], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [script, path.join(dir, 'missing')], { encoding: 'utf8' }).status, 2);
});

test('cli: default scan finds test/ under the working folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-vac-'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'x.test.mjs'), "test('a', () => {});\n");
  const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /x\.test\.mjs:1/);
});

test("this repo's own test folder has no vacuous tests", () => {
  assert.deepEqual(scanPaths([ownTests]), []);
});
