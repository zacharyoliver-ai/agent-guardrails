#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isMain, run } from '../lib/hook-io.mjs';
import { simpleCommands } from '../lib/shell.mjs';

const CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'supabase', 'sqlcmd']);
const LAUNCHERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'npx', 'env']);
// Commands that talk about SQL without running it.
const PROSE = new Set(['git', 'gh', 'echo', 'printf', 'grep', 'rg', 'sed', 'awk', 'cat', 'ls', 'head', 'tail', 'find', 'curl', 'wget']);
const OK = '\u0001';
const NAME = '([\\w$]+(?:\\.[\\w$]+)*)';
const DML = new RegExp(
  [
    `\\bdelete\\s+from\\s+(?:only\\s+)?${NAME}`,
    `\\bupdate\\s+(?:only\\s+)?${NAME}\\s+(?:as\\s+\\w+\\s+)?set\\b`,
    // The lookahead skips GRANT TRUNCATE ON and "truncate the name" in prose.
    `\\btruncate\\s+(?!(?:on|and|or|from|to|the|in|of|is|for|with)\\b)(?:table\\s+)?(?:only\\s+)?${NAME}`,
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
      // E'...' strings also treat backslash as an escape.
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) {
        i += sql[i] === "'" || (escapes && sql[i] === '\\') ? 2 : 1;
      }
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

const isClient = (w) => CLIENTS.has(String(w[0]).toLowerCase());
const CLIENT_WORD = /(?:^|[\s;&|(])(?:psql|mysql|mariadb|sqlite3|supabase|sqlcmd|invoke-sqlcmd)\b/i;
// "echo 'delete from t' | psql": the producer on the left of a pipe feeds the client.
const PIPED_INTO_CLIENT = /\|\s*(?:(?:sudo|command|time|nohup|exec|npx|xargs)\s+)*(?:psql|mysql|mariadb|sqlite3|supabase|sqlcmd|invoke-sqlcmd)\b/i;
const MAX_FILE = 1024 * 1024;

/** Bodies of heredocs that are fed to a SQL client. */
function heredocBodies(command) {
  const lines = command.split(/\r?\n/);
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /(?<!<)<<(?!<)-?\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(lines[i]);
    if (!m) continue;
    // Only the command the heredoc belongs to counts, not an earlier one on the same line,
    // or a client it is piped straight into, as in cat <<EOF | psql.
    const owner = lines[i].slice(0, m.index).split(/&&|\|\||[;|&(`]/).pop();
    const pipedOn = /^[^;&]*/.exec(lines[i].slice(m.index))[0];
    if (!CLIENT_WORD.test(owner) && !PIPED_INTO_CLIENT.test(pipedOn)) continue;
    const delim = m[1] ?? m[2] ?? m[3];
    const body = [];
    for (i++; i < lines.length && lines[i].trim() !== delim; i++) body.push(lines[i]);
    bodies.push(body.join('\n'));
  }
  return bodies;
}

/** Files a client reads its SQL from: -f file, --file file, --file=file, < file. */
function inputFiles(words) {
  const files = [];
  words.forEach((x, i) => {
    const next = words[i + 1];
    if (/^(?:-f|-i|--file|<)$/.test(x) && next) files.push(next);
    else if (x.startsWith('--file=')) files.push(x.slice(7));
    else if (/^<[^<]/.test(x)) files.push(x.slice(1));
  });
  return files;
}

function readSmall(file, cwd) {
  try {
    const full = path.resolve(cwd || process.cwd(), file);
    return fs.statSync(full).size < MAX_FILE ? fs.readFileSync(full, 'utf8') : null;
  } catch {
    return null; // hooks fail open
  }
}

/** The command xargs runs, after its own flags, so "xargs grep 'delete from t'" counts as a search. */
function afterXargs(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += /^-[nIPLsdEa]$/.test(words[i]) ? 2 : 1;
  return words.slice(i);
}

function bashTexts(command, cwd) {
  const cmds = simpleCommands(command).map((w) => {
    let x = w;
    while (LAUNCHERS.has(x[0]) || x[0] === 'xargs') x = x[0] === 'xargs' ? afterXargs(x) : x.slice(1);
    return x;
  });
  const clients = cmds.filter(isClient);
  if (clients.length) {
    // Only the client's own words, its heredocs and what is piped into it.
    const words = clients.map((w) => w.join(' '));
    if (PIPED_INTO_CLIENT.test(command)) {
      words.push(...cmds.filter((w) => w[0] === 'echo' || w[0] === 'printf').map((w) => w.slice(1).join(' ')));
    }
    const texts = [[words.join('\n;\n'), false], ...heredocBodies(command).map((b) => [b, false])];
    for (const w of clients) {
      for (const f of inputFiles(w)) {
        const text = readSmall(f, cwd);
        if (text !== null) texts.push([text, false]);
      }
    }
    return texts;
  }
  const text = cmds.filter((w) => w[0] && !PROSE.has(w[0])).map((w) => w.join(' ')).join('\n;\n');
  // Here SQL sits inside a string of another language, so strings are kept.
  // Known limit: a script that only mentions SQL, such as one patching a file with node -e, reads as SQL.
  return [[text, true]];
}

/** Returns a deny reason, or null to allow. */
export function check(input, env = process.env) {
  const ti = input.tool_input || {};
  let texts;
  if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') {
    if (typeof ti.command !== 'string') return null;
    texts = bashTexts(ti.command, input.cwd);
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
