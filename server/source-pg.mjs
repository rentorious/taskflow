// A pushed cycle, read back out of Postgres as the RawCycle model.mjs expects.
//
// A source is made for one project and one owner, and every statement in here
// carries both. That is the tenancy rule, and it is structural: there is no
// argument a caller could pass to reach another project's rows. The plan-text
// cache lives in this closure for the same reason. Keyed by hash alone and shared,
// it would hand one project's plan to another project's forged manifest.

import { rawFromPayload } from '../scripts/report/payload.mjs';

const MAX_CACHED_PLANS = 500;
const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * @param {object} db
 * @param {object} where
 * @param {string} where.projectId
 * @param {string|number} where.ownerId  whose cycles these are
 * @param {boolean} [where.readOnly]     the viewer cannot write here
 */
export function createPgSource(db, { projectId, ownerId, readOnly = true }) {
  const planText = new Map();
  const lastPayload = new Map(); // cycle id as the page knows it -> the payload last read

  function findCycle(id) {
    return id === 'live'
      ? db.query('select id, snapshot, rev, pushed_at, pushed_from from cycle where project_id = $1 and user_id = $2 and is_live', [projectId, ownerId])
      : db.query('select id, snapshot, rev, pushed_at, pushed_from from cycle where project_id = $1 and user_id = $2 and not is_live and archived_as = $3', [projectId, ownerId, id]);
  }

  async function blob(sha256) {
    const { rows } = await db.query('select body from blob where project_id = $1 and sha256 = $2', [projectId, sha256]);
    return rows[0]?.body ?? null;
  }

  async function read(id) {
    const isArchive = id !== 'live';
    const row = (await findCycle(id)).rows[0];
    const cycle = { id, isArchive, hosted: true, readOnly, uuid: row?.id ?? null, pushedAt: iso(row?.pushed_at), pushedFrom: row?.pushed_from ?? null };
    if (!row) {
      lastPayload.delete(id);
      // A project nobody has pushed to yet: an empty cycle, which the page knows how to say.
      return { cycle: { dir: null, indexFile: null, slug: null, stateFiles: [], ...cycle }, index: null, batchFiles: {}, locks: {}, plans: {}, attachments: {}, summaryFile: null, config: null, problems: [] };
    }

    const payload = row.snapshot;
    lastPayload.set(id, payload);

    const wanted = [...new Set([
      ...Object.values(payload.plans).map((p) => p.sha256),
      ...Object.values(payload.attachments).flatMap((files) => files.map((f) => f.sha256)),
      ...(payload.summary ? [payload.summary.sha256] : []),
    ])];
    const held = new Set(wanted.length ? (await db.query('select sha256 from blob where project_id = $1 and sha256 = any($2::text[])', [projectId, wanted])).rows.map((r) => r.sha256) : []);

    const uncached = Object.values(payload.plans).map((p) => p.sha256).filter((hash) => held.has(hash) && !planText.has(hash));
    if (uncached.length) {
      if (planText.size + uncached.length > MAX_CACHED_PLANS) planText.clear();
      const { rows } = await db.query('select sha256, body from blob where project_id = $1 and sha256 = any($2::text[])', [projectId, uncached]);
      for (const found of rows) planText.set(found.sha256, found.body.toString('utf8'));
    }

    return rawFromPayload(payload, { text: (hash) => (held.has(hash) ? planText.get(hash) : undefined), has: (hash) => held.has(hash), cycle });
  }

  return {
    /** The live cycle always exists for the page, pushed or not; archives are whatever pushes have superseded. */
    async listCycles() {
      const { rows } = await db.query('select archived_as from cycle where project_id = $1 and user_id = $2 and not is_live order by pushed_at desc', [projectId, ownerId]);
      return [{ id: 'live', isArchive: false }, ...rows.map((r) => ({ id: r.archived_as, isArchive: true }))];
    },

    reader: (id) => ({ read: () => read(id) }),

    /** One cheap statement: the counters every write bumps, and the time of the last push. */
    async signature(id) {
      const row = (await findCycle(id)).rows[0];
      const project = (await db.query('select human_rev from project where id = $1', [projectId])).rows[0];
      return `${row ? `${row.id}:${row.rev}:${iso(row.pushed_at)}` : 'none'}|${project?.human_rev ?? 'gone'}`;
    },

    async summaryText(id) {
      if (!lastPayload.has(id)) await read(id);
      const hash = lastPayload.get(id)?.summary?.sha256;
      return hash ? (await blob(hash))?.toString('utf8') ?? '' : '';
    },

    /** @returns {Promise<{etag: string, open: () => Promise<Buffer|null>}|null>} */
    async attachment(id, taskId, name) {
      if (!lastPayload.has(id)) await read(id);
      const file = lastPayload.get(id)?.attachments?.[taskId]?.find((f) => f.name === name);
      if (!file) return null;
      // Whether the bytes arrived is asked without fetching them: node-postgres buffers a bytea whole.
      const held = await db.query('select 1 from blob where project_id = $1 and sha256 = $2', [projectId, file.sha256]);
      if (!held.rowCount) return null;
      return { etag: file.sha256, open: () => blob(file.sha256) };
    },
  };
}
