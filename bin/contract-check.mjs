#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/hook-io.mjs';
import { plantedFault } from './planted-fault.mjs';

const slashes = (p) => String(p).replace(/\\/g, '/');

/** Maps a plantedFault exit code to a status word. A timeout (3) proves nothing, so it is UNPROVEN like any setup problem. */
export function statusOf(code) {
  if (code === 0) return 'PROVEN';
  if (code === 1) return 'MISSED';
  return 'UNPROVEN';
}

function proveLine(line, root, timeout) {
  const { test, fault } = line;
  if (!test || typeof test !== 'string') return { status: 'UNPROVEN', detail: 'no test named' };
  if (!fault || !fault.file || !fault.find || fault.replace === undefined) {
    return { status: 'UNPROVEN', detail: 'no planted fault (file, find, replace) given' };
  }
  const file = path.resolve(root, fault.file);
  if (!fs.existsSync(file)) return { status: 'UNPROVEN', detail: `fault file ${fault.file} does not exist` };
  const { code, message } = plantedFault({ file, find: fault.find, replace: fault.replace, test, cwd: root, timeout });
  return { status: statusOf(code), detail: code === 0 ? '' : message.split('\n')[0] };
}

function loadContracts(dir) {
  const stat = fs.existsSync(dir) && fs.statSync(dir);
  if (!stat) throw new Error(`contracts folder ${dir} does not exist`);
  const files = stat.isDirectory()
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f))
    : [dir];
  if (files.length === 0) throw new Error(`no .json contracts in ${dir}`);
  return files.map((f) => {
    try {
      return { file: f, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch (err) {
      throw new Error(`${f} is not valid JSON: ${err.message}`);
    }
  });
}

/**
 * Proves every always/never line of every contract in dir.
 * With `changed`, only contracts whose fault files include one of those paths are re-proved.
 */
export function checkContracts({ dir = 'contracts', root = process.cwd(), changed = null, timeout } = {}) {
  const results = [];
  const touched = changed && new Set(changed.map((c) => slashes(path.relative(root, path.resolve(root, c)))));
  for (const c of loadContracts(path.resolve(root, dir))) {
    const lines = [...(c.always || []).map((l) => ['always', l]), ...(c.never || []).map((l) => ['never', l])];
    if (touched && !lines.some(([, l]) => l.fault && touched.has(slashes(path.relative(root, path.resolve(root, l.fault.file || '')))))) continue;
    for (const [kind, line] of lines) {
      results.push({ feature: c.feature, kind, rule: line.rule, ...proveLine(line, root, timeout) });
    }
  }
  return results;
}

function parse(argv) {
  const out = { dir: 'contracts', json: false, changed: null };
  let inChanged = false;
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--changed') (out.changed = out.changed || []), (inChanged = true);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (inChanged) out.changed.push(a);
    else out.dir = a;
  }
  return out;
}

if (isMain(import.meta.url)) {
  let opts;
  let results;
  try {
    opts = parse(process.argv.slice(2));
    results = checkContracts(opts);
  } catch (err) {
    console.error(`contract-check: ${err.message}`);
    console.error('Usage: contract-check [contracts-folder] [--changed <file>...] [--json]');
    process.exit(2);
  }
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const r of results) console.log(`${r.status.padEnd(8)} ${r.feature} (${r.kind}): ${r.rule}${r.detail ? `\n         ${r.detail}` : ''}`);
    const proven = results.filter((r) => r.status === 'PROVEN').length;
    console.log(`${proven} of ${results.length} lines proven`);
  }
  process.exit(results.every((r) => r.status === 'PROVEN') ? 0 : 1);
}
