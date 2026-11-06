import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { check, checkSql } from '../hooks/bulk-write-gate.mjs';
import { tmpDir } from '../lib/temp-dirs.mjs';

const script = fileURLToPath(new URL('../hooks/bulk-write-gate.mjs', import.meta.url));
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const sqlTool = (query, name = 'mcp__db__execute_sql') => ({ tool_name: name, tool_input: { query } });
const PROTECTED_T = { GUARDRAILS_PROTECTED_TABLES: 't' };
const PROTECTED ={ GUARDRAILS_PROTECTED_TABLES: 'users, Orders' };

test('writes with no WHERE are denied', () => {
  for (const s of [
    'UPDATE t SET a = 1', 'DELETE FROM t', 'delete from public.t', 'update "public"."t" set a = 1',
    'SELECT 1; DELETE FROM t', 'WITH x AS (SELECT 1) DELETE FROM t', 'DELETE FROM ONLY t',
    'UPDATE t SET a = (SELECT b FROM c WHERE c.id = 1)', '/* tidy */ DELETE FROM t -- later',
    'UPDATE t AS x SET a = 1',
  ]) assert.match(checkSql(s, {}), /every row/, s);
});

test('a WHERE that is always true counts as none', () => {
  for (const s of [
    'DELETE FROM t WHERE 1=1', 'DELETE FROM t WHERE 1 = 1', 'DELETE FROM t WHERE true', 'UPDATE t SET a = 1 WHERE (1=1)',
    'DELETE FROM t WHERE 1=1 AND true', 'DELETE FROM t WHERE id = 5 OR 1=1', "DELETE FROM t WHERE 'a' = 'a'", 'DELETE FROM t WHERE id = id',
  ]) assert.match(checkSql(s, {}), /always true/, s);
});

test('TRUNCATE and DROP TABLE are denied', () => {
  for (const s of ['TRUNCATE t', 'truncate table public.t', 'TRUNCATE TABLE ONLY t']) assert.match(checkSql(s, {}), /removes every row/, s);
  for (const s of ['DROP TABLE t', 'drop table if exists "public"."t"']) assert.match(checkSql(s, {}), /and all its rows/, s);
});

test('narrow writes and reads pass', () => {
  for (const s of [
    'DELETE FROM t WHERE id = 1', 'UPDATE t SET a = 1 WHERE id IN (SELECT id FROM u)', "DELETE FROM t WHERE name = 'a;b'",
    "SELECT 'DROP TABLE x'", 'SELECT * FROM t', "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2",
    '-- DELETE FROM t\nSELECT 1', '/* TRUNCATE t */ SELECT 1', 'SELECT $$DELETE FROM t$$', 'DELETE FROM t WHERE id = $1',
    'CREATE TABLE c (id int REFERENCES t ON DELETE CASCADE ON UPDATE CASCADE)', 'UPDATE t SET a = 1 WHERE id = 1 RETURNING *',
  ]) assert.equal(checkSql(s, {}), null, s);
});

test('a bulk-ok comment with a reason allows its statement only', () => {
  assert.equal(checkSql('DELETE FROM t -- bulk-ok: resetting the fixture table', {}), null);
  assert.equal(checkSql('-- bulk-ok: nightly cleanup\nTRUNCATE t', {}), null);
  assert.equal(checkSql('DROP TABLE t; -- bulk-ok: obsolete', {}), null);
  assert.notEqual(checkSql('-- bulk-ok: first\nDELETE FROM a;\nDELETE FROM b', {}), null);
  assert.notEqual(checkSql('DELETE FROM t -- bulk-ok:', {}), null);
  assert.notEqual(checkSql('DELETE FROM t -- fine', {}), null);
});

test('protected tables refuse any UPDATE, DELETE or ALTER', () => {
  for (const s of [
    'UPDATE users SET a = 1 WHERE id = 1', 'DELETE FROM public.users WHERE id = 1', 'ALTER TABLE orders ADD COLUMN x int',
    'update "Orders" set a = 1 where id = 2', 'SELECT 1; DELETE FROM users WHERE id = 1',
  ]) assert.match(checkSql(s, PROTECTED), /protected table/, s);
  for (const s of ['SELECT * FROM users', 'INSERT INTO users (a) VALUES (1)', 'DELETE FROM other WHERE id = 1', 'ALTER TABLE other ADD COLUMN x int']) {
    assert.equal(checkSql(s, PROTECTED), null, s);
  }
  assert.equal(checkSql('UPDATE users SET a = 1 WHERE id = 1 -- bulk-ok: backfill approved', PROTECTED), null);
});

test('GUARDRAILS_PROTECTED_TABLES_FILE accepts a list or an object', () => {
  const dir = tmpDir('ag-bw-');
  const list = path.join(dir, 'list.json');
  const obj = path.join(dir, 'obj.json');
  fs.writeFileSync(list, JSON.stringify(['accounts']));
  fs.writeFileSync(obj, JSON.stringify({ tables: ['public.invoices'] }));
  assert.match(checkSql('UPDATE accounts SET a = 1 WHERE id = 1', { GUARDRAILS_PROTECTED_TABLES_FILE: list }), /protected/);
  assert.match(checkSql('DELETE FROM invoices WHERE id = 1', { GUARDRAILS_PROTECTED_TABLES_FILE: obj }), /protected/);
  assert.equal(checkSql('DELETE FROM accounts WHERE id = 1', { GUARDRAILS_PROTECTED_TABLES_FILE: path.join(dir, 'missing.json') }), null);
});

test('SQL tools are read from query, sql or command', () => {
  assert.notEqual(check(sqlTool('DELETE FROM t'), {}), null);
  assert.notEqual(check({ tool_name: 'mcp__postgres__run', tool_input: { sql: 'DELETE FROM t' } }, {}), null);
  assert.notEqual(check({ tool_name: 'supabase_exec', tool_input: { command: 'TRUNCATE t' } }, {}), null);
  assert.notEqual(check(sqlTool('delete from t', 'postgres_query'), {}), null);
  assert.equal(check(sqlTool('SELECT 1'), {}), null);
  assert.equal(check({ tool_name: 'Read', tool_input: { query: 'DELETE FROM t' } }, {}), null);
});

test('Bash: SQL clients are checked', () => {
  for (const c of [
    'psql -c "DELETE FROM users"', "psql -c 'UPDATE users SET a = 1'", 'psql mydb <<EOF\nTRUNCATE users;\nEOF',
    'echo "DELETE FROM users" | psql', 'sqlite3 app.db "DROP TABLE users"', 'mysql -e "delete from users"', 'PGPASSWORD=x psql -c "UPDATE t SET a = 1"',
  ]) assert.notEqual(check(bash(c), {}), null, c);
  for (const c of [
    'psql -c "DELETE FROM users WHERE id = 1"', 'psql -c "select 1"', `psql -c "SELECT 'DROP TABLE x'"`,
    'psql -c "DELETE FROM t -- bulk-ok: test data"', 'psql mydb <<EOF\nDELETE FROM t WHERE id = 1;\nEOF', 'psql -c "\\dt"',
  ]) assert.equal(check(bash(c), {}), null, c);
});

test('Bash: other commands only count when they carry SQL', () => {
  assert.notEqual(check(bash(`node -e "db.query('DELETE FROM users')"`), {}), null);
  for (const c of ['git commit -m "update docs"', 'git commit -m "DELETE FROM users"', 'echo "drop table x"', 'ls -la', 'npm test -- --update', 'grep -r "delete from" src', 'node script.js']) {
    assert.equal(check(bash(c), {}), null, c);
  }
});

test('TRUNCATE as a privilege or a plain word is not a truncate', () => {
  for (const q of ['GRANT TRUNCATE ON t TO app', 'REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM app', 'select a as truncate from t']) {
    assert.equal(check(sqlTool(q), {}), null, q);
  }
  assert.equal(check(bash(`node -e "log('truncate and retry')"`), {}), null);
  for (const q of ['TRUNCATE t', 'TRUNCATE TABLE t', 'truncate only t', 'TRUNCATE public.t CASCADE']) {
    assert.notEqual(check(sqlTool(q), {}), null, q);
  }
});

test('Bash: xargs is judged by the command it runs', () => {
  for (const c of ['ls | xargs grep "delete from users"', 'ls | xargs -n 1 grep -l "drop table users"', 'ls | xargs -I {} grep "truncate users" {}']) {
    assert.equal(check(bash(c), {}), null, c);
  }
  for (const c of [
    'ls | xargs psql -c "DELETE FROM users"',
    'ls | xargs -n 1 psql -c "DROP TABLE users"',
    'echo "DELETE FROM users" | xargs psql -c',
    `ls | xargs -I {} node -e "db.query('DELETE FROM users')"`,
  ]) assert.notEqual(check(bash(c), {}), null, c);
});

test('Bash: prose next to a SQL client is not read as SQL', () => {
  for (const c of [
    'psql -c "select 1" && git commit -m "delete from stale cache"',
    'psql -c "select 1"; echo "update the set"',
    `curl -d '{"q":"update the set"}' https://example.com`,
  ]) assert.equal(check(bash(c), {}), null, c);
  assert.equal(check(bash('psql -c "select 1" && git commit -m "$(cat <<\'EOF\'\ndelete from t\nEOF\n)"'), {}), null);
  assert.notEqual(check(bash('psql -c "select 1" && psql -c "delete from t"'), {}), null);
  assert.notEqual(check(bash('psql -c "select 1" && psql <<EOF\ndelete from t;\nEOF'), {}), null);
  assert.notEqual(check(bash('echo "delete from t" | psql mydb'), {}), null);
});

test('Bash: a heredoc piped straight into a client is read, and any other heredoc is not', () => {
  assert.notEqual(check(bash('cat <<EOF | psql\ndelete from users;\nEOF'), {}), null);
  assert.equal(check(bash('cat <<EOF | psql\ndelete from users where id = 1;\nEOF'), {}), null);
  assert.equal(check(bash('cat <<EOF | grep x\ndelete from users;\nEOF'), {}), null);
  assert.equal(check(bash('cat <<EOF > notes.txt; psql -c "select 1"\ndelete from users;\nEOF'), {}), null);
});

test('PowerShell is read like Bash', () => {
  const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
  assert.notEqual(check(ps('Invoke-Sqlcmd "delete from t"'), {}), null);
  assert.equal(check(ps('Invoke-Sqlcmd "select 1"'), {}), null);
});

test('Bash: SQL files given to a client are read', () => {
  const dir = tmpDir('ag-bw-sql-');
  fs.writeFileSync(path.join(dir, 'migrate.sql'), 'delete from t;\n');
  fs.writeFileSync(path.join(dir, 'safe.sql'), 'delete from t where id = 1;\n');
  const at = (command) => ({ ...bash(command), cwd: dir });
  for (const c of ['psql -f migrate.sql', 'psql --file=migrate.sql', 'psql mydb < migrate.sql', 'psql <migrate.sql']) {
    assert.match(check(at(c), {}), /every row/, c);
  }
  assert.equal(check(at('psql -f safe.sql'), {}), null);
  assert.equal(check(at('psql -f missing.sql'), {}), null);
  assert.match(check(at('psql -f migrate.sql'), PROTECTED_T), /protected|every row/);
});

test('E-strings treat a backslash quote as an escape', () => {
  assert.match(checkSql("select E'a\\'b'; delete from t", {}), /every row/);
  assert.match(check(bash(`psql -c "select E'a\\\\'b'; delete from t"`), {}), /every row/);
  assert.equal(checkSql("select E'a\\'; delete from t'", {}), null);
  assert.match(checkSql("select 'a\\'; delete from t", {}), /every row/);
});

test('script: malformed stdin allows with one stderr line', () => {
  const r = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('script: prints a deny decision', () => {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(sqlTool('DELETE FROM t')), encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
