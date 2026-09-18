// What the CLI asks of the server, beyond pushing (ingest.mjs): claim a batch,
// give it back, and read the state a claim was decided on.
//
// The claim is the gate. It is decided here, in one transaction, on the cycle as
// it was last pushed and on the answers as they stand: scripts/report/gate.mjs
// says whether the batch may start, and the claim table's partial unique index
// says who got it. The CLI pushes first, so "as last pushed" is "as of now".

import { openCycleFrom } from '../scripts/report/cycle.mjs';
import { EXIT, evaluateClaim } from '../scripts/report/gate.mjs';
import { SAFE_NAME } from '../scripts/report/read.mjs';
import { createPgSource } from './source-pg.mjs';
import { createPgHumanStore } from './store-pg.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** The developer's live cycle as the page and the gate both see it. */
async function build(db, { projectId, userId }) {
  const source = createPgSource(db, { projectId, ownerId: userId, readOnly: false });
  const cycle = openCycleFrom({
    reader: source.reader('live'),
    humanFor: (raw) => createPgHumanStore(db, { projectId, cycleUuid: raw.cycle.uuid }),
  });
  return cycle.build({ enrichment: (raw) => raw.enrichment });
}

/** Only what concerns this developer's tasks: answers are per project, and a teammate's are not theirs to download. */
function ownRecords(records, model) {
  const items = Object.fromEntries(Object.entries(records.items).filter(([id, entry]) => !id.startsWith('question:') || entry.taskId in model.tasks));
  return { items, problems: records.problems };
}

/** GET state: what `taskflow answers | questions | status` render from. */
export async function cycleState(db, { projectId, userId }) {
  const { raw, records, model } = await build(db, { projectId, userId });
  if (!raw.index) throw fail(409, 'Nothing has been pushed for this project yet. Run: taskflow push');
  return { model, records: ownRecords(records, model) };
}

/**
 * @returns {Promise<object>} the verdict of gate.mjs, plus `claimed` and, on success, the state to render answers from
 */
export function claimBatch(db, { projectId, userId, batchKey = null, stack = false, resume = false, host = null }) {
  if (batchKey !== null && !SAFE_NAME.test(String(batchKey))) throw fail(400, `Not a batch key: ${batchKey}`);

  return db.tx(async (q) => {
    // Same lock as a push: a claim never interleaves with this developer's own push or another claim.
    const member = await q.query('select role from membership where project_id = $1 and user_id = $2 for update', [projectId, userId]);
    if (!member.rowCount) throw fail(404, 'No such project.');
    if (!['admin', 'developer'].includes(member.rows[0].role)) throw fail(403, 'Only a developer of this project can claim a batch.');

    const { raw, records, model } = await build(db, { projectId, userId });
    if (!raw.index) throw fail(409, 'Nothing has been pushed for this project yet. Run: taskflow push');

    const verdict = evaluateClaim(model, { batchKey, stack, resume });
    if (verdict.exit !== EXIT.OK) return { ...verdict, claimed: null };

    let claimed = null;
    for (const key of verdict.candidates) {
      if (verdict.resume && !verdict.relock) { claimed = key; break; }
      // The index decides. A savepoint keeps a lost race from poisoning the transaction.
      await q.query('savepoint take');
      try {
        await q.query('insert into claim (project_id, cycle_id, batch_key, user_id, host) values ($1, $2, $3, $4, $5)', [projectId, raw.cycle.uuid, key, userId, host ? String(host).slice(0, 200) : null]);
        await q.query('release savepoint take');
        claimed = key;
        break;
      } catch (error) {
        if (error.code !== '23505') throw error;
        await q.query('rollback to savepoint take');
        if (batchKey) return { ...verdict, exit: EXIT.LOCKED, claimed: null, message: `${key} was just claimed by another session.` };
      }
    }
    if (!claimed) return { ...verdict, exit: EXIT.NOTHING, claimed: null, message: 'Every ready batch was claimed by another session in the meantime.' };

    await q.query('update cycle set rev = rev + 1 where id = $1', [raw.cycle.uuid]);
    await q.query('insert into audit_log (user_id, project_id, action, payload) values ($1, $2, $3, $4)', [userId, projectId, 'claim', JSON.stringify({ batch: claimed, host, resumed: verdict.resume })]);
    return { ...verdict, batchKey: claimed, claimed, model, records: ownRecords(records, model) };
  });
}

export function releaseBatch(db, { projectId, userId, batchKey }) {
  if (!SAFE_NAME.test(String(batchKey ?? ''))) throw fail(400, `Not a batch key: ${batchKey}`);
  return db.tx(async (q) => {
    const cycle = (await q.query('select id from cycle where project_id = $1 and user_id = $2 and is_live for update', [projectId, userId])).rows[0];
    if (!cycle) return { released: false };
    const done = await q.query('update claim set released_at = now() where cycle_id = $1 and batch_key = $2 and released_at is null', [cycle.id, batchKey]);
    if (done.rowCount) {
      await q.query('update cycle set rev = rev + 1 where id = $1', [cycle.id]);
      await q.query('insert into audit_log (user_id, project_id, action, payload) values ($1, $2, $3, $4)', [userId, projectId, 'release', JSON.stringify({ batch: batchKey })]);
    }
    return { released: done.rowCount > 0 };
  });
}

/** /taskflow:clean ran: the cycle is history. Its answers are not: they belong to the project. */
export function archiveCycle(db, { projectId, userId, cycleId }) {
  return db.tx(async (q) => {
    const cycle = (await q.query('select id, last_triage from cycle where id = $1 and project_id = $2 and user_id = $3 and is_live for update', [cycleId, projectId, userId])).rows[0];
    if (!cycle) return { archived: null };
    const taken = new Set((await q.query('select archived_as from cycle where project_id = $1 and user_id = $2 and not is_live', [projectId, userId])).rows.map((r) => r.archived_as));
    const base = SAFE_NAME.test(cycle.last_triage ?? '') ? cycle.last_triage.slice(0, 60) : new Date().toISOString().slice(0, 10);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    await q.query('update cycle set is_live = false, archived_as = $2, rev = rev + 1 where id = $1', [cycle.id, name]);
    await q.query('insert into audit_log (user_id, project_id, action, payload) values ($1, $2, $3, $4)', [userId, projectId, 'archive', JSON.stringify({ cycle: cycle.id, as: name })]);
    return { archived: name };
  });
}
