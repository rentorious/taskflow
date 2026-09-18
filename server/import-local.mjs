// The one-time move of what a developer recorded locally (answers.json and the
// live cycle's inbox tick file) onto a hosted project.
//
// First wins, per question. A question that already has anything on the server
// is left alone and listed as skipped; everything else comes in. Nothing is ever
// merged within a question, so there is still one writer per datum, and a second
// developer hosting the same project later loses nothing. Running it again
// imports nothing.

import { randomBytes } from 'node:crypto';
import { isQuestion } from '../scripts/report/human.mjs';
import { MAX_ANSWER_CHARS, MAX_NOTE_CHARS, MAX_SOURCE_CHARS, QUESTION_RESOLUTIONS } from '../scripts/report/human-rules.mjs';
import { SAFE_NAME } from '../scripts/report/read.mjs';
import { MAX_TICK_NOTE_CHARS } from '../scripts/report/ticks.mjs';

const MAX_ITEMS = 5000;
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const when = (value) => { const date = new Date(value ?? NaN); return Number.isNaN(date.getTime()) ? new Date() : date; };

/** @returns {string|null} why this entry cannot come in as it stands */
function unusable(entry) {
  if (!entry || typeof entry !== 'object') return 'not an object';
  if (typeof entry.taskId !== 'string' || !SAFE_NAME.test(entry.taskId)) return 'no usable task id';
  if (typeof entry.key !== 'string' || !entry.key || entry.key.length > 200) return 'no usable key';
  const answers = Array.isArray(entry.answers) ? entry.answers : [];
  // The file store refuses these on the way in. A file edited by hand is not cut to fit; it is left for a person to look at.
  if (answers.some((a) => typeof a?.body !== 'string' || !a.body.trim() || a.body.length > MAX_ANSWER_CHARS)) return 'an answer is empty or too long';
  if (answers.some((a) => String(a?.source ?? '').length > MAX_SOURCE_CHARS)) return 'a source is too long';
  if (String(entry.note ?? '').length > MAX_NOTE_CHARS) return 'the note is too long';
  return null;
}

/**
 * @param {object} db
 * @param {object} input
 * @param {string} input.projectId
 * @param {string|number} input.userId     the developer doing the import; vouches for every answer
 * @param {string|null} [input.cycleUuid]  the live cycle the tick file belongs to
 * @param {object|null} [input.answersJson]
 * @param {object|null} [input.ticksJson]
 */
export function importLocalHumanState(db, { projectId, userId, cycleUuid = null, answersJson = null, ticksJson = null }) {
  return db.tx(async (q) => {
    // Same mutex as every other human write: nobody answers a question while it is being imported.
    const bumped = await q.query('update project set human_rev = human_rev + 1 where id = $1', [projectId]);
    if (bumped.rowCount !== 1) throw Object.assign(new Error('No such project.'), { status: 404 });

    const report = { questions: { imported: 0, skipped: [] }, answers: 0, ticks: { imported: 0, skipped: 0 } };

    const entries = Object.entries(answersJson?.items ?? {}).slice(0, MAX_ITEMS);
    for (const [id, entry] of entries) {
      const reason = unusable(entry);
      if (reason) { report.questions.skipped.push({ id, reason }); continue; }
      const where = [projectId, entry.taskId, entry.key];

      const taken = await q.query(
        `select 1 where exists (select 1 from question_state where project_id = $1 and task_id = $2 and key = $3)
                     or exists (select 1 from answer where project_id = $1 and task_id = $2 and key = $3)`, where);
      if (taken.rowCount) { report.questions.skipped.push({ id, reason: 'already recorded on the server' }); continue; }

      const answers = Array.isArray(entry.answers) ? entry.answers : [];
      const resolution = QUESTION_RESOLUTIONS.has(entry.resolution) || entry.resolution === 'answered' ? entry.resolution : null;
      // "answered" with no answer behind it would open the gate on nothing.
      if (resolution === 'answered' && !answers.length) { report.questions.skipped.push({ id, reason: 'marked answered, but holds no answer' }); continue; }

      await q.query(
        `insert into question_state (project_id, task_id, key, resolution, fingerprint, question_title, question_text, note, updated_at, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [...where, resolution, typeof entry.fingerprint === 'string' ? entry.fingerprint : null, text(entry.title, 2000), text(entry.text, 20000), text(entry.note, MAX_NOTE_CHARS), when(entry.at), userId],
      );
      const seen = new Set();
      for (const a of answers) {
        // The page sends an answer's id back as "the newest I had seen", so ids are kept where they can be.
        const publicId = typeof a.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(a.id) && !seen.has(a.id) ? a.id : randomBytes(6).toString('hex');
        seen.add(publicId);
        const at = when(a.at);
        await q.query(
          `insert into answer (public_id, project_id, task_id, key, body, source, question_fingerprint, question_title, question_text, idempotency_key, via, accepted_by, accepted_at, created_at, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $12)`,
          [publicId, ...where, a.body.trim(), text(a.source, MAX_SOURCE_CHARS).trim(), typeof a.questionFingerprint === 'string' ? a.questionFingerprint : null,
            text(a.questionTitle, 2000), text(a.questionText, 20000), typeof a.idempotencyKey === 'string' && a.idempotencyKey.length <= 80 ? a.idempotencyKey : null,
            a.via === 'mcp' ? 'mcp' : 'web', userId, at],
        );
        report.answers++;
      }
      report.questions.imported++;
    }

    if (cycleUuid) {
      const owned = await q.query('select 1 from cycle where id = $1 and project_id = $2', [cycleUuid, projectId]);
      if (!owned.rowCount) throw Object.assign(new Error('No such cycle in this project.'), { status: 404 });
      for (const [id, tick] of Object.entries(ticksJson?.items ?? {}).slice(0, MAX_ITEMS)) {
        // A question's state lives with its answers. A bare tick on one is from before answers existed.
        if (isQuestion(id) || typeof tick?.resolution !== 'string' || id.length > 400) { report.ticks.skipped++; continue; }
        const inserted = await q.query(
          `insert into inbox_tick (project_id, cycle_id, item_id, resolution, fingerprint, title, note, updated_at, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (cycle_id, item_id) do nothing`,
          [projectId, cycleUuid, id, tick.resolution.slice(0, 40), typeof tick.fingerprint === 'string' ? tick.fingerprint : null, text(tick.title, 2000), text(tick.note, MAX_TICK_NOTE_CHARS), when(tick.at), userId],
        );
        if (inserted.rowCount) report.ticks.imported++;
        else report.ticks.skipped++;
      }
    }

    await q.query('insert into audit_log (user_id, project_id, action, payload) values ($1, $2, $3, $4)', [userId, projectId, 'import-local',
      JSON.stringify({ questions: report.questions.imported, skipped: report.questions.skipped.length, answers: report.answers, ticks: report.ticks })]);
    return report;
  });
}
