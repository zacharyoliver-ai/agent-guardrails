#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, matchGlob } from '../lib/hook-io.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git']);
const lf = (s) => s.replace(/\r\n/g, '\n');

function walk(dir, root, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, root, out);
    else out.push(path.relative(root, full).replace(/\\/g, '/'));
  }
  return out;
}

function validate(pins) {
  if (!Array.isArray(pins)) throw new Error('the pins file must hold a list');
  pins.forEach((p, i) => {
    const target = Boolean(p.file) !== Boolean(p.glob);
    const text = Boolean(p.must) !== Boolean(p.mustNot);
    if (!target) throw new Error(`pin ${i + 1} needs exactly one of "file" or "glob"`);
    if (!text) throw new Error(`pin ${i + 1} needs exactly one of "must" or "mustNot"`);
  });
}

/** Returns findings: { file, problem, why, line? }. An empty list means every pin holds. */
export function checkPins(pins, root = process.cwd()) {
  validate(pins);
  const findings = [];
  let all = null;
  for (const pin of pins) {
    let files;
    if (pin.file) files = [pin.file.replace(/\\/g, '/')];
    else {
      all = all || walk(root, root, []);
      files = all.filter((f) => matchGlob(pin.glob, f));
      if (files.length === 0 && pin.must) {
        findings.push({ file: pin.glob, problem: 'no file matches this pattern, so the pinned text cannot be there', why: pin.why });
      }
    }
    for (const file of files) {
      const full = path.join(root, file);
      if (!fs.existsSync(full)) {
        findings.push({ file, problem: 'the pinned file is missing', why: pin.why });
        continue;
      }
      const text = lf(fs.readFileSync(full, 'utf8'));
      if (pin.must) {
        if (!text.includes(lf(pin.must))) findings.push({ file, problem: `the pinned wording is gone or changed: ${JSON.stringify(pin.must)}`, why: pin.why });
      } else {
        const at = text.indexOf(lf(pin.mustNot));
        if (at >= 0) {
          findings.push({ file, line: text.slice(0, at).split('\n').length, problem: `forbidden text is present: ${JSON.stringify(pin.mustNot)}`, why: pin.why });
        }
      }
    }
  }
  return findings;
}

if (isMain(import.meta.url)) {
  let findings;
  let values;
  try {
    ({ values } = parseArgs({ options: { pins: { type: 'string' }, root: { type: 'string' }, json: { type: 'boolean' } } }));
    const pinsFile = values.pins || 'pins.json';
    findings = checkPins(JSON.parse(fs.readFileSync(pinsFile, 'utf8')), values.root || process.cwd());
  } catch (err) {
    console.error(`pin-check: ${err.message}`);
    console.error('Usage: pin-check [--pins <file>] [--root <folder>] [--json]');
    process.exit(2);
  }
  if (values.json) console.log(JSON.stringify(findings, null, 2));
  else {
    for (const f of findings) console.log(`${f.file}${f.line ? `:${f.line}` : ''}: ${f.problem}${f.why ? `\n  why it is pinned: ${f.why}` : ''}`);
  }
  process.exit(findings.length ? 1 : 0);
}
