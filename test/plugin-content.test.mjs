import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const agents = fs.readdirSync(path.join(root, 'agents')).filter((f) => f.endsWith('.md')).map((f) => `agents/${f}`);
const skills = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `skills/${e.name}/SKILL.md`);
const files = [...agents, ...skills];

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return null;
  return Object.fromEntries(
    m[1].split(/\r?\n/).map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter(Boolean).map((x) => [x[1], x[2]]),
  );
}

test('the plugin ships three agents and three skills', () => {
  assert.equal(agents.length, 3);
  assert.equal(skills.length, 3);
});

for (const rel of files) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');

  test(`${rel} has a name and a description in its frontmatter`, () => {
    const fm = frontmatter(text);
    assert.ok(fm, 'no frontmatter');
    assert.ok(fm.name, 'no name');
    assert.ok(fm.description && fm.description.length > 10, 'no description');
  });

  test(`${rel} is under 60 lines`, () => {
    assert.ok(text.split(/\r?\n/).length <= 60);
  });

  test(`every repo path named in ${rel} exists`, () => {
    const named = text.match(/\b(?:bin|hooks|lib|test|examples|contracts|proof|docs|skills|agents)\/[\w./-]*/g) || [];
    for (const raw of named) {
      const p = raw.replace(/[.,]+$/, '');
      assert.ok(fs.existsSync(path.join(root, p)), `${rel} names ${p}, which does not exist`);
    }
  });
}

test('a skill folder name matches its frontmatter name', () => {
  for (const rel of skills) {
    const fm = frontmatter(fs.readFileSync(path.join(root, rel), 'utf8'));
    assert.equal(fm.name, rel.split('/')[1]);
  }
});
