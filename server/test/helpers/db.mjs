// A database for one test file: a throwaway schema inside the test database.
//
// Test files run in parallel, so each gets its own schema and drops it at the
// end. The URL comes from TASKFLOW_TEST_DATABASE_URL (server/.env.test). When it
// is missing the suite fails with instructions; it never skips, because a
// skipped suite reads as a green one.

import { randomBytes } from 'node:crypto';
import { createDb } from '../../db.mjs';
import { migrate } from '../../migrate.mjs';

const STALE_AFTER_S = 60 * 60;

export function testDatabaseUrl() {
  const url = process.env.TASKFLOW_TEST_DATABASE_URL;
  if (!url) {
    throw new Error([
      'TASKFLOW_TEST_DATABASE_URL is not set, so the server tests cannot run.',
      'Create a database for them once, then put its URL in server/.env.test:',
      '  createdb -h localhost -p 5433 -U postgres taskflow_test',
      "  echo 'TASKFLOW_TEST_DATABASE_URL=postgres://postgres:<password>@localhost:5433/taskflow_test' > server/.env.test",
      'and run the tests with: npm --prefix server test',
    ].join('\n'));
  }
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  // These tests create and drop schemas. They must never be pointed at anything that matters.
  if (!/test/i.test(name)) throw new Error(`Refusing to run tests against the database "${name}": its name does not contain "test".`);
  return url;
}

/** Schemas left by runs that crashed. Only old ones: another test file may be using a young one right now. */
async function sweep(admin) {
  const { rows } = await admin.query("select nspname from pg_namespace where nspname ~ '^t_[0-9]+_[0-9a-f]+$'");
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_S;
  for (const { nspname } of rows) {
    if (Number.parseInt(nspname.split('_')[1], 10) < cutoff) await admin.query(`drop schema if exists ${nspname} cascade`);
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.migrated]  false leaves the schema empty, for the migration tests
 * @returns {Promise<{db: object, url: string, schema: string, open: () => object, close: () => Promise<void>}>}
 */
export async function testDb({ migrated = true } = {}) {
  const url = testDatabaseUrl();
  const schema = `t_${Math.floor(Date.now() / 1000)}_${randomBytes(5).toString('hex')}`;
  const admin = createDb(url, { max: 1 });
  await sweep(admin);
  await admin.query(`create schema ${schema}`);

  const pools = [];
  const open = () => { const db = createDb(url, { schema }); pools.push(db); return db; };
  const db = open();
  if (migrated) await migrate(db);

  return {
    db,
    url,
    schema,
    /** A second pool on the same schema: another server process, as far as the database can tell. */
    open,
    async close() {
      await Promise.all(pools.map((pool) => pool.close()));
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.close();
    },
  };
}
