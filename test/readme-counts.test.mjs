import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

// Apart from the fault files on purpose: a matrix run tests each tool before PROOF.md is rewritten.
test('the counts in the README and PROOF.md match the fault files', () => {
  const dir = path.join(root, 'proof', 'faults');
  const tools = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const total = tools.reduce((sum, t) => sum + t.faults.length, 0);
  const readme = read('README.md');
  assert.ok(readme.includes(`carries ${total} planted faults across ${tools.length} tools`), `README paragraph should say ${total} and ${tools.length}`);
  assert.ok(readme.includes(`planted%20faults-${total}-`), `README badge should say ${total}`);
  assert.ok(read('PROOF.md').includes(`${total} of ${total} planted faults are caught, across ${tools.length} tools`), 'run node bin/proof-matrix.mjs --write');
});
