// Persistence for questions: what was asked, what came back, and whether the
// question is settled. One `answers.json` per project, at the top of the output
// directory, not inside a cycle.
//
// Ticks die with their cycle; answers must not. A question is keyed by task and
// key, so an answer follows its task through /taskflow:clean and a re-triage.
// The record mirrors the hosted design's `question_state` and `answer` tables:
// the state is replaced, the answers only ever grow.

import { randomBytes } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const SCHEMA_VERSION = 1;
export const ANSWERS_FILE = 'answers.json';
export const MAX_ANSWER_CHARS = 8000;
export const MAX_SOURCE_CHARS = 200;
export const MAX_NOTE_CHARS = 2000;
const RESOLUTIONS = new Set(['sent', 'dropped']);

const empty = () => ({ schema_version: SCHEMA_VERSION, updated_at: null, items: {} });
const fail = (status, message) => Object.assign(new Error(message), { status });

function text(value, max, label) {
  const out = String(value ?? '').trim();
  // Refuse rather than cut: a silently shortened client answer is worse than an error.
  if (out.length > max) throw fail(413, `${label} is too long: ${out.length} characters, ${max} at most.`);
  return out;
}

/**
 * @param {string} path  <output_dir>/answers.json
 * @param {object} [options]
 * @param {boolean} [options.readOnly]    archives show answers but never write them
 * @param {string}  [options.archiveRoot] <output_dir>/archive, searched when the file is missing
 */
export function createAnswerStore(path, { readOnly = false, archiveRoot = null } = {}) {
  let queue = Promise.resolve();

  /** The newest archived copy, for the case where a clean-up moved the live file away. */
  async function newestArchivedCopy() {
    if (!archiveRoot) return null;
    const names = (await readdir(archiveRoot, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    for (const name of names) {
      const candidate = join(archiveRoot, name, ANSWERS_FILE);
      try {
        const data = JSON.parse(await readFile(candidate, 'utf8'));
        if (data && typeof data.items === 'object' && data.items !== null) return { name, candidate };
      } catch {
        // Not there, or not usable: try the next archive.
      }
    }
    return null;
  }

  async function quarantined() {
    const prefix = `${basename(path)}.corrupt-`;
    return (await readdir(dirname(path)).catch(() => [])).filter((name) => name.startsWith(prefix)).sort();
  }

  /** @returns {Promise<{data: object, problems: object[]}>} */
  async function load() {
    const problems = [];
    const problem = (code, message) => problems.push({ code, subject: ANSWERS_FILE, message, since: null, usingLastGood: false });
    let data = null;
    let raw = null;

    try {
      raw = await readFile(path, 'utf8');
    } catch {
      const found = readOnly ? null : await newestArchivedCopy();
      if (found) {
        // Answers are the one thing here that cannot be regenerated, and keeping
        // them out of an archive is only a rule in a skill's prose.
        try {
          const restored = JSON.parse(await readFile(found.candidate, 'utf8'));
          restored.restored_from = found.name;
          const temp = `${path}.${process.pid}.tmp`;
          await writeFile(temp, `${JSON.stringify(restored, null, 2)}\n`);
          await rename(temp, path);
          raw = JSON.stringify(restored);
        } catch {
          // Could not copy it back: carry on empty, the archive still holds it.
        }
      }
    }

    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.items !== 'object' || parsed.items === null || Array.isArray(parsed.items)) throw new Error('missing items');
        data = parsed;
      } catch {
        if (!readOnly) await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
      }
    }
    data ??= empty();

    if (data.restored_from) problem('answers-restored', `answers.json was missing and was copied back from archive/${data.restored_from}. Answers must stay out of archives.`);
    for (const name of await quarantined()) problem('answers-corrupt', `A damaged answers file was set aside as ${name}. Answers recorded before that are inside it. Delete it once recovered.`);
    return { data, problems };
  }

  function write(change) {
    if (readOnly) return Promise.reject(fail(403, 'This cycle is archived and read-only.'));
    queue = queue.catch(() => {}).then(async () => {
      const { data } = await load();
      const result = change(data);
      if (result?.unchanged) return result.value;
      data.schema_version = SCHEMA_VERSION;
      data.updated_at = new Date().toISOString();
      delete data.restored_from;
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
      await rename(temp, path);
      return result?.value ?? data.items;
    });
    return queue;
  }

  function record(data, id, question) {
    const entry = (data.items[id] ??= { taskId: question.taskId, key: question.key, resolution: null, fingerprint: null, title: '', text: '', note: '', at: null, answers: [] });
    entry.answers ??= [];
    return entry;
  }

  function stamp(entry, question, resolution, note) {
    entry.taskId = question.taskId;
    entry.key = question.key;
    entry.resolution = resolution;
    entry.fingerprint = question.fingerprint;
    entry.title = question.title;
    entry.text = question.text;
    entry.note = note;
    entry.at = new Date().toISOString();
  }

  return {
    path,
    load,

    /**
     * Mark a question sent or dropped, or reopen it with `resolution: null`.
     * "answered" is never set here: only an answer answers a question.
     * @param {string} id
     * @param {{taskId,key,fingerprint,title,text}} question  the question as it reads now
     */
    setResolution(id, question, { resolution, note = '' }) {
      if (resolution !== null && !RESOLUTIONS.has(resolution)) return Promise.reject(fail(400, 'A question is answered by saving an answer. Use sent, dropped, or reopen it.'));
      return write((data) => {
        const cleanNote = text(note, MAX_NOTE_CHARS, 'The note');
        // Dropping is the only way past the claim gate without an answer, so it must say why.
        if (resolution === 'dropped' && !cleanNote) throw fail(400, 'Say why this question is being dropped.');
        stamp(record(data, id, question), question, resolution, cleanNote);
        return { value: data.items[id] };
      });
    },

    /**
     * @param {object} answer
     * @param {string} answer.body
     * @param {string} [answer.source]            who said it, where, when
     * @param {string} [answer.idempotencyKey]    a retried save must not add a second answer
     * @param {string|null} [answer.previousAnswerId]  the newest answer the writer had seen; undefined skips the check
     * @param {string} [answer.via]               "web" now; "mcp" later
     */
    addAnswer(id, question, { body, source = '', idempotencyKey = null, previousAnswerId, via = 'web' }) {
      return write((data) => {
        const cleanBody = text(body, MAX_ANSWER_CHARS, 'The answer');
        if (!cleanBody) throw fail(400, 'The answer is empty.');
        const cleanSource = text(source, MAX_SOURCE_CHARS, 'The source');
        const entry = record(data, id, question);

        const replay = idempotencyKey ? entry.answers.find((a) => a.idempotencyKey === idempotencyKey) : null;
        if (replay) return { unchanged: true, value: entry };

        const newest = entry.answers.at(-1)?.id ?? null;
        if (previousAnswerId !== undefined && (previousAnswerId ?? null) !== newest) {
          throw fail(409, 'Someone saved another answer to this question in the meantime. Reload and check it.');
        }

        entry.answers.push({
          id: randomBytes(6).toString('hex'),
          at: new Date().toISOString(),
          body: cleanBody,
          source: cleanSource,
          via,
          // What was actually answered, word for word: the question may be reworded or removed later.
          questionFingerprint: question.fingerprint,
          questionTitle: question.title,
          questionText: question.text,
          idempotencyKey: idempotencyKey ? String(idempotencyKey).slice(0, 80) : null,
        });
        stamp(entry, question, 'answered', '');
        return { value: entry };
      });
    },

    /**
     * "The reworded question still means the same": move the state onto the
     * current wording. The answer keeps the wording it was given for.
     */
    confirm(id, question) {
      return write((data) => {
        const entry = data.items[id];
        if (!entry?.resolution) throw fail(400, 'There is nothing recorded on this question to confirm.');
        stamp(entry, question, entry.resolution, entry.note ?? '');
        return { value: entry };
      });
    },
  };
}
