// The HumanStore of scripts/report/human.mjs, over Postgres.
//
// Same methods, same refusals (scripts/report/human-rules.mjs), and `load()`
// returns records in exactly the shape the file store does, so inbox.mjs and
// model.mjs cannot tell the two apart. test/contracts/human-store.mjs holds both
// to the same assertions.
//
// What is different is that a writer is known. A store is made for one actor:
//   { id, login, role }   role as in `membership`: admin | developer | answerer
//
// An answerer's answer is a proposal. It is stored, it is never loaded, and it
// never marks its question answered: the claim gate reads a question's state, so
// a state stamped by a proposal would open the gate with nothing behind it.

import { randomBytes } from 'node:crypto';
import { isQuestion, questionOf } from '../scripts/report/human.mjs';
import { checkResolution, cleanAnswer, cleanResolutionNote, fail, placeAnswer } from '../scripts/report/human-rules.mjs';
import { MAX_TICK_NOTE_CHARS } from '../scripts/report/ticks.mjs';

const VOUCHES = new Set(['admin', 'developer']);
const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * @param {object} db  from db.mjs
 * @param {object} where
 * @param {string} where.projectId
 * @param {string|null} where.cycleUuid  the cycle the per-cycle ticks belong to; null before anything was pushed
 * @param {boolean} [where.isArchive]
 * @param {{id: string, login: string, role: string}|null} [where.actor]  null can read, never write
 */
export function createPgHumanStore(db, { projectId, cycleUuid = null, isArchive = false, actor = null }) {
  /**
   * Every write starts here. The UPDATE takes the project's row lock, so writes to
   * one project queue up behind each other: "is my view of this question still the
   * newest" is answered without a race, and no second lock is needed.
   */
  function write(action, work) {
    if (isArchive) return Promise.reject(fail(403, 'This cycle is archived and read-only.'));
    if (!actor) return Promise.reject(fail(403, 'Sign in to change anything here.'));
    return db.tx(async (q) => {
      const bumped = await q.query('update project set human_rev = human_rev + 1 where id = $1', [projectId]);
      if (bumped.rowCount !== 1) throw fail(404, 'No such project.');
      const detail = await work(q);
      await q.query('insert into audit_log (user_id, project_id, action, payload) values ($1, $2, $3, $4)', [actor.id, projectId, action, JSON.stringify(detail ?? {})]);
    });
  }

  function stamp(q, question, resolution, note) {
    return q.query(
      `insert into question_state (project_id, task_id, key, resolution, fingerprint, question_title, question_text, note, updated_at, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       on conflict (project_id, task_id, key) do update set
         resolution = excluded.resolution, fingerprint = excluded.fingerprint, question_title = excluded.question_title,
         question_text = excluded.question_text, note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [projectId, question.taskId, question.key, resolution, question.fingerprint ?? null, question.title ?? '', question.text ?? '', note, actor.id],
    );
  }

  return {
    /** @returns {Promise<{items: object, problems: object[]}>} one record per inbox item id */
    async load() {
      const items = {};

      if (cycleUuid) {
        const ticks = await db.query('select item_id, resolution, fingerprint, title, note, updated_at from inbox_tick where project_id = $1 and cycle_id = $2', [projectId, cycleUuid]);
        for (const row of ticks.rows) {
          // As in human.mjs: a bare "answered" tick on a question has no answer behind it, so it never opens a live gate.
          if (isQuestion(row.item_id) && !isArchive) continue;
          items[row.item_id] = { resolution: row.resolution, at: iso(row.updated_at), fingerprint: row.fingerprint, title: row.title, note: row.note };
        }
      }

      const states = await db.query('select task_id, key, resolution, fingerprint, question_title, question_text, note, updated_at from question_state where project_id = $1', [projectId]);
      const answers = await db.query(
        `select task_id, key, public_id, body, source, via, question_fingerprint, question_title, question_text, idempotency_key, created_at
         from answer where project_id = $1 and accepted_at is not null order by id`,
        [projectId],
      );
      const byQuestion = new Map();
      for (const row of answers.rows) {
        const id = `question:${row.task_id}:${row.key}`;
        if (!byQuestion.has(id)) byQuestion.set(id, Object.assign([], { taskId: row.task_id, key: row.key }));
        byQuestion.get(id).push({
          id: row.public_id, at: iso(row.created_at), body: row.body, source: row.source, via: row.via,
          questionFingerprint: row.question_fingerprint, questionTitle: row.question_title, questionText: row.question_text, idempotencyKey: row.idempotency_key,
        });
      }

      const entries = new Map(states.rows.map((row) => [`question:${row.task_id}:${row.key}`, {
        taskId: row.task_id, key: row.key, resolution: row.resolution, fingerprint: row.fingerprint,
        title: row.question_title, text: row.question_text, note: row.note, at: iso(row.updated_at), answers: [],
      }]));
      for (const [id, list] of byQuestion) {
        // An answer with no state row is one whose question was never stamped; it is still history.
        if (!entries.has(id)) entries.set(id, { taskId: list.taskId, key: list.key, resolution: null, fingerprint: null, title: '', text: '', note: '', at: null, answers: [] });
        entries.get(id).answers = [...list];
      }
      for (const [id, entry] of entries) if (entry.resolution || entry.answers.length) items[id] = entry;

      return { items, problems: [] };
    },

    /** Tick, untick (`resolution: null`), mark sent, drop or reopen. */
    setResolution(item, { resolution, note = '' }) {
      if (item.kind === 'question') {
        try {
          checkResolution(resolution);
        } catch (error) {
          return Promise.reject(error);
        }
        return write('question.resolution', async (q) => {
          const cleanNote = cleanResolutionNote(resolution, note);
          await stamp(q, questionOf(item), resolution, cleanNote);
          return { item: item.id, resolution };
        });
      }

      return write('tick', async (q) => {
        if (!cycleUuid) throw fail(409, 'Nothing has been pushed for this cycle yet.');
        if (resolution === null) {
          await q.query('delete from inbox_tick where cycle_id = $1 and item_id = $2 and project_id = $3', [cycleUuid, item.id, projectId]);
        } else {
          await q.query(
            `insert into inbox_tick (project_id, cycle_id, item_id, resolution, fingerprint, title, note, updated_at, updated_by)
             values ($1, $2, $3, $4, $5, $6, $7, now(), $8)
             on conflict (cycle_id, item_id) do update set
               resolution = excluded.resolution, fingerprint = excluded.fingerprint, title = excluded.title,
               note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
            [projectId, cycleUuid, item.id, resolution, item.fingerprint ?? null, item.title ?? '', String(note ?? '').slice(0, MAX_TICK_NOTE_CHARS), actor.id],
          );
        }
        return { item: item.id, resolution };
      });
    },

    addAnswer(item, { body, source = '', idempotencyKey = null, previousAnswerId, via = 'web' }) {
      return write('answer', async (q) => {
        const clean = cleanAnswer({ body, source, idempotencyKey, via });
        const question = questionOf(item);
        const where = [projectId, question.taskId, question.key];

        // A retry is recognised against every row, proposals included: the key is unique across all of them.
        if (clean.idempotencyKey) {
          const replay = await q.query('select 1 from answer where project_id = $1 and task_id = $2 and key = $3 and idempotency_key = $4', [...where, clean.idempotencyKey]);
          if (replay.rowCount) return { item: item.id, replay: true };
        }
        // "Newest" is the newest answer anyone can see. A pending proposal must not lock developers out with 409s.
        const accepted = await q.query('select public_id as id from answer where project_id = $1 and task_id = $2 and key = $3 and accepted_at is not null order by id', where);
        placeAnswer(accepted.rows, { idempotencyKey: null, previousAnswerId });

        const vouched = VOUCHES.has(actor.role);
        await q.query(
          `insert into answer (public_id, project_id, task_id, key, body, source, question_fingerprint, question_title, question_text, idempotency_key, via, accepted_by, accepted_at, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [randomBytes(6).toString('hex'), ...where, clean.body, clean.source, question.fingerprint ?? null, question.title ?? '', question.text ?? '',
            clean.idempotencyKey, clean.via === 'mcp' ? 'mcp' : 'web', vouched ? actor.id : null, vouched ? new Date() : null, actor.id],
        );
        if (vouched) await stamp(q, question, 'answered', '');
        return { item: item.id, proposed: !vouched };
      });
    },

    /** "The reworded question still means the same": move the state onto the current wording. */
    confirm(item) {
      return write('question.confirm', async (q) => {
        const question = questionOf(item);
        const found = await q.query('select resolution, note from question_state where project_id = $1 and task_id = $2 and key = $3', [projectId, question.taskId, question.key]);
        if (!found.rows[0]?.resolution) throw fail(400, 'There is nothing recorded on this question to confirm.');
        await stamp(q, question, found.rows[0].resolution, found.rows[0].note ?? '');
        return { item: item.id };
      });
    },
  };
}
