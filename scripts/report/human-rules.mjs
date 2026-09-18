// What a store of answers must refuse, whatever it keeps them in.
//
// The file store (answers.mjs) and the hosted server's database store share
// these, so a question cannot be settled on one and refused on the other. Pure:
// no I/O. Every rejection is an Error carrying the HTTP status it maps to.

export const MAX_ANSWER_CHARS = 8000;
export const MAX_SOURCE_CHARS = 200;
export const MAX_NOTE_CHARS = 2000;
export const MAX_IDEMPOTENCY_KEY_CHARS = 80;

/** A person may mark a question sent or dropped. "answered" is never set by hand. */
export const QUESTION_RESOLUTIONS = new Set(['sent', 'dropped']);

export const fail = (status, message) => Object.assign(new Error(message), { status });

/** Refuse rather than cut: a silently shortened client answer is worse than an error. */
export function cleanText(value, max, label) {
  const out = String(value ?? '').trim();
  if (out.length > max) throw fail(413, `${label} is too long: ${out.length} characters, ${max} at most.`);
  return out;
}

/** Sent, dropped, or reopen (`null`). */
export function checkResolution(resolution) {
  if (resolution !== null && !QUESTION_RESOLUTIONS.has(resolution)) throw fail(400, 'A question is answered by saving an answer. Use sent, dropped, or reopen it.');
}

/** @returns {string} the note, trimmed */
export function cleanResolutionNote(resolution, note) {
  const clean = cleanText(note, MAX_NOTE_CHARS, 'The note');
  // Dropping is the only way past the claim gate without an answer, so it must say why.
  if (resolution === 'dropped' && !clean) throw fail(400, 'Say why this question is being dropped.');
  return clean;
}

/** @returns {{body: string, source: string, idempotencyKey: string|null, via: string}} */
export function cleanAnswer({ body, source = '', idempotencyKey = null, via = 'web' }) {
  const cleanBody = cleanText(body, MAX_ANSWER_CHARS, 'The answer');
  if (!cleanBody) throw fail(400, 'The answer is empty.');
  const cleanSource = cleanText(source, MAX_SOURCE_CHARS, 'The source');
  const key = idempotencyKey === null || idempotencyKey === undefined || idempotencyKey === '' ? null : String(idempotencyKey);
  // A key that was stored cut would never match its own retry.
  if (key && key.length > MAX_IDEMPOTENCY_KEY_CHARS) throw fail(400, `The idempotency key is too long: ${MAX_IDEMPOTENCY_KEY_CHARS} characters at most.`);
  return { body: cleanBody, source: cleanSource, idempotencyKey: key, via };
}

/**
 * Where a new answer stands against the ones already there, newest last.
 * A retried save is recognised first: its `previousAnswerId` is stale by construction.
 * @param {{id: string, idempotencyKey?: string|null}[]} answers
 * @param {string|null|undefined} previousAnswerId  the newest answer the writer had seen; undefined skips the check
 * @returns {'replay'|'append'}
 */
export function placeAnswer(answers, { idempotencyKey, previousAnswerId }) {
  if (idempotencyKey && answers.some((a) => a.idempotencyKey === idempotencyKey)) return 'replay';
  const newest = answers.at(-1)?.id ?? null;
  if (previousAnswerId !== undefined && (previousAnswerId ?? null) !== newest) {
    throw fail(409, 'Someone saved another answer to this question in the meantime. Reload and check it.');
  }
  return 'append';
}
