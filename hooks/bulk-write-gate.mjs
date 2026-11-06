#!/usr/bin/env node
import fs from 'node:fs';
import { isMain, run } from '../lib/hook-io.mjs';
import { simpleCommands } from '../lib/shell.mjs';

const CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'supabase', 'sqlcmd']);
const LAUNCHERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'npx', 'env']);
// Commands that talk about SQL without running it.
const PROSE = new Set(['git', 'gh', 'echo', 'printf', 'grep', 'rg', 'sed', 'awk', 'cat', 'ls', 'head', 'tail', 'find']);
const OK = '\u0001';
const NAME = '([\\w$]+(?:\\.[\\w$]+)*)';
const DML = new RegExp(
  [
    `\\bdelete\\s+from\\s+(?:only\\s+)?${NAME}`,
    `\\bupdate\\s+(?:only\\s+)?${NAME}\\s+(?:as\\s+\\w+\\s+)?set\\b`,
    `\\btruncate\\s+(?:table\\s+)?(?:only\\s+)?${NAME}`,
    `\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?${NAME}`,
    `\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${NAME}`,
  ].join('|'),
  'gi',
);

/**
 * Removes comments and string literals so keywords inside them are ignored,
 * drops identifier quotes, and turns a "-- bulk-ok: reason" comment into a marker.
 */
export function cleanSql(sql, keepStrings = false) {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      out += /^--\s*bulk-ok:\s*\S/i.test(sql.slice(i, end)) ? OK : ' ';
      i = end - 1;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
    } else if (c === "'" && !keepStrings) {
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
      out += "''";
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      const end = tag ? sql.indexOf(tag[0], i + tag[0].length) : -1;
      if (end === -1) out += c;
      else {
        i = end + tag[0].length - 1;
        out += "''";
      }
    } else if (c !== '"' && c !== '`') out += c;
  }
  return out;
}

const lastPart = (name) => name.toLowerCase().split('.').pop();

/** Text after the first top-level WHERE, up to RETURNING, or null when there is none. */
function whereClause(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (depth === 0 && /^where\b/i.test(text.slice(i)) && (i === 0 || /\W/.test(text[i - 1]))) {
      return text.slice(i + 5).split(/\breturning\b/i)[0];
    }
  }
  return null;
}

const trivial = (part) => {
  const p = part.replace(/[()\s]/g, '').toLowerCase();
  return p === '' || p === 'true' || p === '1' || p === 'notfalse' || /^(\w+|'')=\1$/.test(p);
};
const alwaysTrue = (cond) => cond.split(/\bor\b/i).some((or) => or.split(/\band\b/i).every(trivial));

/** Reason for one statement, or null. */
function checkStatement(stmt, protectedTables) {
  const matches = [...stmt.matchAll(DML)];
  for (let k = 0; k < matches.length; k++) {
    const m = matches[k];
    const verb = m[0].trim().split(/\s+/)[0].toLowerCase();
    const table = m.slice(1).find(Boolean);
    const guarded = protectedTables.has(lastPart(table));
    if (verb === 'truncate') return `TRUNCATE removes every row of ${table}. Delete with a WHERE that selects the rows, or add a comment "-- bulk-ok: <reason>" to the statement if emptying the table is intended.`;
    if (verb === 'drop') return `DROP TABLE removes ${table} and all its rows. Add a comment "-- bulk-ok: <reason>" to the statement if that is intended.`;
    if (guarded) return `${table} is a protected table, so UPDATE, DELETE and ALTER on it need a comment "-- bulk-ok: <reason>" in the statement. Add it if the change is intended.`;
    if (verb === 'alter') continue;
    const rest = stmt.slice(m.index + m[0].length, matches[k + 1]?.index ?? stmt.length);
    const cond = whereClause(rest);
    if (cond === null || alwaysTrue(cond)) {
      return `This ${verb.toUpperCase()} on ${table} has ${cond === null ? 'no WHERE clause' : 'a WHERE clause that is always true'}, so it changes every row. Add a WHERE that selects the rows, or add a comment "-- bulk-ok: <reason>" to the statement if every row is intended.`;
    }
  }
  return null;
}

export function protectedTables(env = process.env) {
  const names = [];
  if (env.GUARDRAILS_PROTECTED_TABLES) names.push(...env.GUARDRAILS_PROTECTED_TABLES.split(','));
  if (env.GUARDRAILS_PROTECTED_TABLES_FILE) {
    try {
      const data = JSON.parse(fs.readFileSync(env.GUARDRAILS_PROTECTED_TABLES_FILE, 'utf8'));
      names.push(...(Array.isArray(data) ? data : data.tables || []));
    } catch {
      // unreadable list: use the environment variable alone
    }
  }
  return new Set(names.map((n) => lastPart(String(n).trim().replace(/["`]/g, ''))).filter(Boolean));
}

/** Reason for a block of SQL text, or null. */
export function checkSql(sql, env = process.env, keepStrings = false) {
  const tables = protectedTables(env);
  const statements = cleanSql(sql, keepStrings).split(';');
  const ok = statements.map((s) => s.includes(OK));
  for (let i = 1; i < statements.length; i++) if (statements[i].replace(OK, '').trim() === '' && ok[i]) ok[i - 1] = true;
  for (let i = 0; i < statements.length; i++) {
    if (ok[i]) continue;
    const reason = checkStatement(statements[i], tables);
    if (reason) return reason;
  }
  return null;
}

function bashTexts(command) {
  const cmds = simpleCommands(command).map((w) => {
    let x = w;
    while (LAUNCHERS.has(x[0])) x = x.slice(1);
    return x;
  });
  if (cmds.some((w) => CLIENTS.has(w[0]))) {
    // Two views: the arguments with shell quotes removed, and the raw text for heredocs and pipes.
    return [[cmds.map((w) => w.join(' ')).join('\n;\n'), false], [command, false]];
  }
  const text = cmds.filter((w) => w[0] && !PROSE.has(w[0])).map((w) => w.join(' ')).join('\n;\n');
  // Here SQL sits inside a string of another language, so strings are kept.
  return [[text, true]];
}

/** Returns a deny reason, or null to allow. */
export function check(input, env = process.env) {
  const ti = input.tool_input || {};
  let texts;
  if (input.tool_name === 'Bash') {
    if (typeof ti.command !== 'string') return null;
    texts = bashTexts(ti.command);
  } else if (/sql|query|postgres|supabase/i.test(String(input.tool_name))) {
    texts = [ti.query, ti.sql, ti.command].filter((t) => typeof t === 'string').map((t) => [t, false]);
  } else return null;
  for (const [text, keepStrings] of texts) {
    const reason = checkSql(text, env, keepStrings);
    if (reason) return reason;
  }
  return null;
}

if (isMain(import.meta.url)) await run('bulk-write-gate', (input) => check(input));
