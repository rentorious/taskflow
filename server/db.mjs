// The one place that talks to `pg`. Everything else takes a `db`:
//
//   db.query(text, params)   one statement on any pooled connection
//   db.tx(async (q) => ...)  one transaction; `q.query` is bound to its connection
//   db.close()

import { Pool } from 'pg';

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
const STATEMENT_TIMEOUT_MS = 15 * 1000;
const IDLE_IN_TRANSACTION_MS = 30 * 1000;

/**
 * @param {string} connectionString
 * @param {object} [options]
 * @param {string|null} [options.schema]  tests only: run inside this schema. It travels as a
 *   connection option, never inside a statement, and is never read from the environment.
 */
export function createDb(connectionString, { schema = null, max = 5 } = {}) {
  if (!connectionString) throw new Error('No database URL given.');
  if (schema !== null && !SCHEMA.test(schema)) throw new Error(`Not a usable schema name: ${schema}`);

  const settings = [`statement_timeout=${STATEMENT_TIMEOUT_MS}`, `idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_MS}`];
  if (schema) settings.push(`search_path=${schema}`);
  const pool = new Pool({ connectionString, max, options: settings.map((s) => `-c ${s}`).join(' ') });

  // An idle connection that the server drops emits here. With no listener, that is an uncaught exception.
  pool.on('error', (error) => console.error(`[db] idle connection lost: ${error.message}`));

  return {
    schema,
    query: (text, params) => pool.query(text, params),

    async tx(work) {
      const client = await pool.connect();
      let broken = null;
      try {
        await client.query('BEGIN');
        const result = await work({ query: (text, params) => client.query(text, params) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch((rollbackError) => { broken = rollbackError; });
        throw error;
      } finally {
        // A connection that could not roll back is in an unknown state: drop it, do not reuse it.
        client.release(broken ?? undefined);
      }
    },

    close: () => pool.end(),
  };
}
