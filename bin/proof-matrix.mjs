#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/hook-io.mjs';
import { plantedFault } from './planted-fault.mjs';

const SKIP = new Set(['.git', 'node_modules']);
const KINDS = [
  ['guard', 'Guards'],
  ['stop-hook', 'Stop hooks'],
  ['proof-tool', 'Proof tools'],
  ['cost-tool', 'Cost tools'],
  ['coordination', 'Coordination'],
];

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (SKIP.has(name)) continue;
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.statSync(src).isDirectory()) copyTree(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

const statusWord = (code) => (code === 0 ? 'CAUGHT' : code === 1 ? 'MISSED' : code === 3 ? 'TIMEOUT' : 'ERROR');

function loadTools(dir, only) {
  if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
  const tools = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try {
      return { file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) };
    } catch (err) {
      return { file: f, name: f.replace(/\.json$/, ''), error: `not valid JSON: ${err.message}` };
    }
  });
  if (only) {
    const unknown = only.filter((n) => !tools.some((t) => t.name === n));
    if (unknown.length) throw new Error(`no fault file named ${unknown.join(', ')}`);
    return tools.filter((t) => only.includes(t.name));
  }
  return tools;
}

/**
 * Runs every planted fault in a throwaway copy of root, one at a time, and returns
 * { results, total, caught }. The working tree is never touched.
 */
export function runMatrix({ root = process.cwd(), only = null, faultsDir = 'proof/faults', timeout } = {}) {
  const tools = loadTools(path.join(root, faultsDir), only);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-matrix-'));
  const results = [];
  try {
    copyTree(root, copy);
    for (const tool of tools) {
      const base = { tool: tool.name, kind: tool.kind, what: tool.what };
      if (tool.error || !Array.isArray(tool.faults) || tool.faults.length === 0) {
        results.push({ ...base, fault: '(none)', status: 'ERROR', detail: tool.error || 'no faults listed' });
        continue;
      }
      for (const f of tool.faults) {
        const file = path.join(copy, f.file || '');
        if (!f.file || !fs.existsSync(file)) {
          results.push({ ...base, fault: f.fault, status: 'ERROR', detail: `file ${f.file} does not exist` });
          continue;
        }
        const { code, message } = plantedFault({ file, find: f.find, replace: f.replace, test: f.test, cwd: copy, timeout });
        results.push({ ...base, fault: f.fault, status: statusWord(code), detail: code === 0 ? '' : message.split('\n')[0] });
      }
    }
  } finally {
    try {
      fs.rmSync(copy, { recursive: true, force: true });
    } catch (err) {
      // On Windows a test process left running after a TIMEOUT still holds its folder.
      process.stderr.write(`proof-matrix: could not remove ${copy} (${err.code || err.message}); delete it later\n`);
    }
  }
  const caught = results.filter((r) => r.status === 'CAUGHT').length;
  return { results, total: results.length, caught };
}

const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');

/** The text of PROOF.md. It holds no dates, machine names or timings, so it changes only when the proof does. */
export function renderProof({ results, total, caught }) {
  const tools = new Set(results.map((r) => r.tool));
  const out = [
    '# Proof',
    '',
    'A planted fault is a bug we put in a tool on purpose, in one exact place. We do it in a throwaway copy of the repo, run the tool\'s own test, and the test has to fail. If it still passes, the test was too weak to trust, so a passing suite here means something.',
    '',
    'Re-run it yourself: `node bin/proof-matrix.mjs --check`. CI runs it on Windows, macOS and Linux on every push.',
    '',
    `${caught} of ${total} planted faults are caught, across ${tools.size} tools.`,
    '',
  ];
  for (const [kind, title] of KINDS) {
    const rows = results.filter((r) => r.kind === kind);
    if (!rows.length) continue;
    out.push(`## ${title}`, '', '| Tool | What it guarantees | Bug we planted | Result |', '| --- | --- | --- | --- |');
    let last = null;
    for (const r of rows) {
      const first = r.tool !== last;
      last = r.tool;
      out.push(`| ${first ? `\`${r.tool}\`` : ''} | ${first ? cell(r.what) : ''} | ${cell(r.fault)} | ${r.status} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

if (isMain(import.meta.url)) {
  let values;
  try {
    ({ values } = parseArgs({ options: { check: { type: 'boolean' }, write: { type: 'boolean' }, only: { type: 'string' } } }));
    if (!values.check && !values.write) throw new Error('give --check or --write');
    if (values.write && values.only) throw new Error('--write needs the whole matrix, so it cannot be combined with --only');
  } catch (err) {
    console.error(err.message);
    console.error('Usage: proof-matrix (--check | --write) [--only <name>[,<name>]]');
    process.exit(2);
  }
  let run;
  try {
    run = runMatrix({ only: values.only ? values.only.split(',') : null });
  } catch (err) {
    console.error(`proof-matrix: ${err.message}`);
    process.exit(2);
  }
  for (const r of run.results) console.log(`${r.status.padEnd(6)} ${r.tool}: ${r.fault}${r.detail ? ` (${r.detail})` : ''}`);
  console.log(`${run.caught} of ${run.total} faults caught`);
  if (values.write) fs.writeFileSync('PROOF.md', renderProof(run));
  process.exit(run.caught === run.total ? 0 : 1);
}
