#!/usr/bin/env node
// Numbered SQL migrations: server/migrations/NNN_name.sql, applied in order at boot.
//
// Each migration runs in its own transaction, and that transaction first takes an
// advisory lock. A transaction-scoped lock cannot outlive its connection, so a
// crashed boot never leaves the next one waiting. Two servers starting together
// take turns, and the second finds nothing left to do.
//
// The runner refuses to start the server on anything it cannot explain: an
// applied migration whose file changed, a gap in the numbering, or a database
// that holds migrations this code has never heard of.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const FILE = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const LOCK_CLASS = 1952543595; // "task"; the second key is the schema, so test schemas never queue behind each other
const LOCK_TIMEOUT = '60s';

/** Line endings differ by checkout; the migration does not. */
const checksum = (sql) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

export async function readMigrations(dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter((name) => FILE.test(name)).sort();
  const migrations = [];
  for (const [i, name] of files.entries()) {
    const [, number, label] = FILE.exec(name);
    const version = Number.parseInt(number, 10);
    if (version !== i + 1) throw new Error(`Migrations must be numbered without gaps: expected ${String(i + 1).padStart(3, '0')}, found ${name}.`);
    const sql = await readFile(join(dir, name), 'utf8');
    migrations.push({ version, name: label, file: name, sql, sha256: checksum(sql) });
  }
  return migrations;
}

/** Inside a transaction: wait for our turn, make sure the ledger exists, and read it. */
async function ledger(q) {
  await q.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
  await q.query('set local statement_timeout = 0');
  await q.query('select pg_advisory_xact_lock($1, hashtext(current_schema()))', [LOCK_CLASS]);
  await q.query(`create table if not exists schema_migrations (
    version integer primary key,
    name text not null,
    sha256 text not null,
    applied_at timestamptz not null default now()
  )`);
  return (await q.query('select version, name, sha256 from schema_migrations order by version')).rows;
}

function explain(applied, migrations) {
  for (const row of applied) {
    const known = migrations.find((m) => m.version === row.version);
    if (!known) throw new Error(`The database is newer than this code: it holds migration ${row.version} (${row.name}), which this version does not have. Deploy the newer code; do not roll the database back by hand.`);
    if (known.sha256 !== row.sha256) throw new Error(`Migration ${known.file} changed after it was applied. Applied migrations are history: put the file back and add a new migration instead.`);
  }
}

/**
 * @param {{tx: Function}} db  from db.mjs
 * @returns {Promise<string[]>} the files applied by this call
 */
export async function migrate(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const migrations = await readMigrations(dir);
  const done = [];

  explain(await db.tx(ledger), migrations);

  for (const migration of migrations) {
    const applied = await db.tx(async (q) => {
      const rows = await ledger(q);
      explain(rows, migrations);
      // Another process may have applied it while this one waited for the lock.
      if (rows.some((row) => row.version === migration.version)) return false;
      await q.query(migration.sql);
      await q.query('insert into schema_migrations (version, name, sha256) values ($1, $2, $3)', [migration.version, migration.name, migration.sha256]);
      return true;
    });
    if (applied) { done.push(migration.file); log(`applied ${migration.file}`); }
  }
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createDb } = await import('./db.mjs');
  const db = createDb(process.env.DATABASE_URL);
  try {
    const done = await migrate(db, { log: (line) => console.log(line) });
    console.log(done.length ? `${done.length} migration${done.length === 1 ? '' : 's'} applied.` : 'Nothing to apply.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
