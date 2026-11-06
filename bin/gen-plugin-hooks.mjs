#!/usr/bin/env node
// Writes hooks/hooks.json for the Claude Code plugin from lib/hook-table.mjs.
// With --check it writes nothing and exits 1 when the file differs from the table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/hook-io.mjs';
import { buildHooks } from '../lib/hook-table.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = path.join(root, 'hooks', 'hooks.json');

export function render() {
  return JSON.stringify({ hooks: buildHooks('${CLAUDE_PLUGIN_ROOT}') }, null, 2) + '\n';
}

export function main(argv) {
  const rest = argv.filter((a) => a !== '--check');
  if (rest.length) {
    process.stderr.write('gen-plugin-hooks: the only option is --check\n');
    return 2;
  }
  const want = render();
  if (argv.includes('--check')) {
    let have = '';
    try {
      have = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      // a missing file counts as different
    }
    if (have === want) return 0;
    process.stderr.write('gen-plugin-hooks: hooks/hooks.json differs from lib/hook-table.mjs. Run node bin/gen-plugin-hooks.mjs.\n');
    return 1;
  }
  fs.writeFileSync(target, want);
  console.log('wrote hooks/hooks.json');
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
