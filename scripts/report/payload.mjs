// What leaves the laptop when a cycle is pushed to a hosted server, and the way back.
//
//   buildPayload     RawCycle (from read.mjs) -> { payload, blobs }
//   validatePayload  the server's check, and the client's own before it sends
//   canonicalHash    "did anything change", blind to fields that differ on every run
//   rawFromPayload   payload + blob texts -> RawCycle, for model.mjs
//
// The payload is an allowlist. What people recorded (answers.json, the inbox tick
// file) never travels: once a project is hosted the server owns it. Nor does
// anything derived (answers/*.md, claim.json), any archive, or the project
// config beyond the four values the page shows.
//
// Plan text, the summary and attachments travel as blobs named by their sha256,
// so a push uploads only what the server does not hold yet.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PR_URL } from './enrich.mjs';
import { SAFE_NAME, attachmentType } from './read.mjs';

export const PAYLOAD_SCHEMA = 1;
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const MAX_TASKS = 2000;
const MAX_BATCHES = 500;
const MAX_ATTACHMENTS_PER_TASK = 50;
const MAX_WORKTREES = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// A worktree path ends up inside a double-quoted shell command the page offers for copying
// (inbox.mjs, "git worktree remove"). Nothing that expands inside double quotes may pass.
const SHELL_INERT_PATH = /^[A-Za-z0-9_.,@+=:/\\ ~()[\]-]{1,400}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_LEVEL = ['schema', 'cycle', 'index', 'batchFiles', 'locks', 'summary', 'plans', 'attachments', 'config', 'enrichment', 'problems', 'pushedFrom', 'pluginVersion'];
// Differ on every run without the cycle having changed.
const UNHASHED = new Set(['asOf', 'since', 'pushedFrom', 'pluginVersion']);

const fail = (status, message) => Object.assign(new Error(message), { status });

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// -- build ------------------------------------------------------------------------

/** Batches the model can look at: the index's own, and whatever those depend on. */
function wantedBatchKeys(index) {
  const keys = new Set(Object.keys(index.batches ?? {}));
  for (const batch of Object.values(index.batches ?? {})) {
    for (const dep of Array.isArray(batch?.depends_on) ? batch.depends_on : []) if (typeof dep === 'string') keys.add(dep);
  }
  return keys;
}

const pick = (source, keys) => Object.fromEntries(Object.entries(source ?? {}).filter(([key]) => keys.has(key)));

/**
 * @param {object} input
 * @param {object} input.raw        a RawCycle read from a live cycle directory
 * @param {string} input.cycleId    from cycle-id.mjs
 * @param {object|null} [input.enrichment]  enrich.mjs snapshot(), after settle()
 * @param {string} [input.host]
 * @param {string} [input.pluginVersion]
 * @returns {Promise<{payload: object, blobs: Map<string, {bytes: number, read: () => Promise<Buffer>}>}>}
 */
export async function buildPayload({ raw, cycleId, enrichment = null, host = null, pluginVersion = null }) {
  // A one-shot reader has no last good copy to fall back on: pushing now would wipe the mirror.
  if (!raw.index || raw.problems.some((p) => p.code === 'index-unreadable')) {
    throw fail(409, 'The index could not be read just now (triage may be writing it). Nothing was pushed; try again.');
  }
  if (raw.cycle.isArchive) throw fail(400, 'Only the live cycle is pushed.');

  const dir = raw.cycle.dir;
  const blobs = new Map();
  const problems = [...raw.problems];
  const problem = (code, subject, message) => problems.push({ code, subject, message, since: null, usingLastGood: false });
  const batchKeys = wantedBatchKeys(raw.index);
  const taskIds = new Set(Object.keys(raw.index.tasks ?? {}));

  const plans = {};
  for (const [id, plan] of Object.entries(pick(raw.plans, taskIds))) {
    // read.mjs already cut the text at its limit; hash what the page will show, not the file.
    const body = Buffer.from(plan.markdown, 'utf8');
    const hash = sha256(body);
    blobs.set(hash, { bytes: body.length, read: async () => body });
    plans[id] = { sha256: hash, bytes: plan.bytes, mtimeMs: plan.mtimeMs };
  }

  const attachments = {};
  for (const [id, files] of Object.entries(pick(raw.attachments, taskIds))) {
    const kept = [];
    for (const file of files.slice(0, MAX_ATTACHMENTS_PER_TASK)) {
      const path = join(dir, 'attachments', id, file.name);
      if (file.bytes > MAX_BLOB_BYTES) {
        problem('attachment-too-large', id, `${file.name} is larger than ${MAX_BLOB_BYTES / 1024 / 1024} MB and was left out of the push.`);
        continue;
      }
      let body;
      try {
        body = await readFile(path);
      } catch {
        continue; // Gone since it was listed; the next push sees the final state.
      }
      const hash = sha256(body);
      blobs.set(hash, { bytes: body.length, read: () => readFile(path) });
      // Order is the reader's (localeCompare); a database would sort differently, so the array carries it.
      kept.push({ name: file.name, bytes: file.bytes, sha256: hash });
    }
    if (kept.length) attachments[id] = kept;
  }

  let summary = null;
  if (raw.summaryFile) {
    const body = await readFile(join(dir, raw.summaryFile)).catch(() => null);
    if (body && body.length <= MAX_BLOB_BYTES) {
      const hash = sha256(body);
      blobs.set(hash, { bytes: body.length, read: async () => body });
      summary = { file: raw.summaryFile, sha256: hash, bytes: body.length };
    }
  }

  let sentEnrichment = null;
  if (enrichment) {
    const worktrees = (enrichment.worktrees ?? []).filter((w) => {
      const ok = typeof w?.path === 'string' && typeof w?.branch === 'string' && SHELL_INERT_PATH.test(w.path);
      if (!ok) problem('worktree-path-unsafe', String(w?.branch ?? ''), 'A worktree path holds characters that are unsafe to show inside a command, so the worktree was left out of the push.');
      return ok;
    }).slice(0, MAX_WORKTREES);
    sentEnrichment = { git: enrichment.git ?? 'disabled', gh: enrichment.gh ?? 'disabled', asOf: enrichment.asOf ?? null, prs: enrichment.prs ?? {}, worktrees };
  }

  const payload = {
    schema: PAYLOAD_SCHEMA,
    cycle: { id: cycleId, slug: raw.cycle.slug ?? null, indexFile: raw.cycle.indexFile ?? null, lastTriage: raw.index.last_triage ?? null, devHead: raw.index.dev_head ?? null },
    index: raw.index,
    batchFiles: Object.fromEntries(Object.entries(pick(raw.batchFiles, batchKeys)).map(([key, f]) => [key, { exists: Boolean(f.exists), unreadable: Boolean(f.unreadable), mtimeMs: f.mtimeMs ?? null, data: f.data ?? null }])),
    // What the laptop sees. Once claims live on the server, its claim table is the truth instead.
    locks: Object.fromEntries(Object.entries(pick(raw.locks, batchKeys)).map(([key, lock]) => [key, { mtimeMs: lock.mtimeMs }])),
    summary,
    plans,
    attachments,
    config: raw.config
      ? { projectName: raw.config.projectName ?? null, baseBranch: raw.config.baseBranch ?? null, providerComments: raw.config.providerComments === true, providerEnrichment: raw.config.providerEnrichment === true }
      : null,
    enrichment: sentEnrichment,
    problems,
    pushedFrom: host,
    pluginVersion,
  };
  validatePayload(payload);
  return { payload, blobs };
}

// -- validate ---------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isTime = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isShortString = (value, max) => typeof value === 'string' && value.length <= max;
const nullOr = (check) => (value) => value === null || check(value);

function denyForbiddenKeys(value, path = 'payload') {
  if (Array.isArray(value)) return value.forEach((entry, i) => denyForbiddenKeys(entry, `${path}[${i}]`));
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw fail(400, `${path} holds the key "${key}", which is not accepted.`);
    denyForbiddenKeys(value[key], `${path}.${key}`);
  }
}

function safeKeys(object, label, max) {
  const keys = Object.keys(object);
  if (keys.length > max) throw fail(413, `Too many ${label}: ${keys.length}, ${max} at most.`);
  // These become parts of item ids, of URLs and of commands offered for copying.
  for (const key of keys) if (!SAFE_NAME.test(key)) throw fail(400, `Not a usable name among ${label}: ${JSON.stringify(key)}.`);
  return keys;
}

/** Throws an Error with `.status` 400 or 413. Returns the payload's size in bytes. */
export function validatePayload(payload) {
  const need = (ok, message) => { if (!ok) throw fail(400, `Bad payload: ${message}.`); };

  need(isObject(payload), 'not an object');
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) throw fail(413, `The cycle is too large to push: ${bytes} bytes, ${MAX_PAYLOAD_BYTES} at most.`);
  for (const key of Object.keys(payload)) need(TOP_LEVEL.includes(key), `unknown field "${key}"`);
  denyForbiddenKeys(payload);

  need(payload.schema === PAYLOAD_SCHEMA, `schema ${payload.schema} is not understood`);

  const c = payload.cycle;
  need(isObject(c) && typeof c.id === 'string' && UUID.test(c.id), 'cycle.id is not a uuid');
  need(nullOr((v) => typeof v === 'string' && SAFE_NAME.test(v))(c.slug ?? null), 'cycle.slug');
  need(nullOr((v) => isShortString(v, 200))(c.indexFile ?? null), 'cycle.indexFile');
  need(nullOr((v) => isShortString(v, 40))(c.lastTriage ?? null), 'cycle.lastTriage');
  need(nullOr((v) => isShortString(v, 80))(c.devHead ?? null), 'cycle.devHead');

  need(isObject(payload.index), 'index is missing');
  need(payload.index.tasks === undefined || isObject(payload.index.tasks), 'index.tasks');
  need(payload.index.batches === undefined || isObject(payload.index.batches), 'index.batches');
  const taskIds = new Set(safeKeys(payload.index.tasks ?? {}, 'task ids', MAX_TASKS));
  const batchKeys = new Set(safeKeys(payload.index.batches ?? {}, 'batch keys', MAX_BATCHES));
  for (const batch of Object.values(payload.index.batches ?? {})) {
    for (const dep of Array.isArray(batch?.depends_on) ? batch.depends_on : []) if (typeof dep === 'string') batchKeys.add(dep);
  }

  need(isObject(payload.batchFiles), 'batchFiles');
  for (const key of safeKeys(payload.batchFiles, 'batch files', MAX_BATCHES * 2)) {
    const f = payload.batchFiles[key];
    need(batchKeys.has(key), `batch file ${key} belongs to no batch of this index`);
    need(isObject(f) && typeof f.exists === 'boolean' && typeof f.unreadable === 'boolean' && nullOr(isTime)(f.mtimeMs) && nullOr(isObject)(f.data), `batchFiles.${key}`);
  }
  need(isObject(payload.locks), 'locks');
  for (const key of safeKeys(payload.locks, 'locks', MAX_BATCHES * 2)) {
    need(batchKeys.has(key) && isObject(payload.locks[key]) && isTime(payload.locks[key].mtimeMs), `locks.${key}`);
  }

  const s = payload.summary;
  need(s === null || (isObject(s) && typeof s.file === 'string' && SAFE_NAME.test(s.file) && s.file.endsWith('.md') && SHA256.test(s.sha256) && isCount(s.bytes) && s.bytes <= MAX_BLOB_BYTES), 'summary');

  need(isObject(payload.plans), 'plans');
  for (const id of safeKeys(payload.plans, 'plans', MAX_TASKS)) {
    const p = payload.plans[id];
    need(taskIds.has(id) && isObject(p) && SHA256.test(p.sha256) && isCount(p.bytes) && isTime(p.mtimeMs), `plans.${id}`);
  }

  need(isObject(payload.attachments), 'attachments');
  for (const id of safeKeys(payload.attachments, 'attachment folders', MAX_TASKS)) {
    const files = payload.attachments[id];
    need(taskIds.has(id) && Array.isArray(files) && files.length <= MAX_ATTACHMENTS_PER_TASK, `attachments.${id}`);
    for (const file of files) {
      need(isObject(file) && typeof file.name === 'string' && SAFE_NAME.test(file.name) && attachmentType(file.name) !== null, `attachments.${id}: not an accepted file name`);
      need(SHA256.test(file.sha256) && isCount(file.bytes) && file.bytes <= MAX_BLOB_BYTES, `attachments.${id}/${file.name}`);
    }
  }

  const cfg = payload.config;
  need(cfg === null || (isObject(cfg) && Object.keys(cfg).every((k) => ['projectName', 'baseBranch', 'providerComments', 'providerEnrichment'].includes(k))
    && nullOr((v) => isShortString(v, 200))(cfg.projectName ?? null) && nullOr((v) => isShortString(v, 200))(cfg.baseBranch ?? null)
    && typeof cfg.providerComments === 'boolean' && typeof cfg.providerEnrichment === 'boolean'), 'config');

  const e = payload.enrichment;
  if (e !== null) {
    need(isObject(e) && isShortString(e.git, 40) && isShortString(e.gh, 40) && nullOr((v) => isShortString(v, 40))(e.asOf ?? null) && isObject(e.prs) && Array.isArray(e.worktrees), 'enrichment');
    need(Object.keys(e.prs).length <= MAX_BATCHES * 2, 'enrichment.prs: too many');
    for (const [url, pr] of Object.entries(e.prs)) need(PR_URL.test(url) && isObject(pr), `enrichment.prs: ${JSON.stringify(url)}`);
    need(e.worktrees.length <= MAX_WORKTREES, 'enrichment.worktrees: too many');
    for (const w of e.worktrees) need(isObject(w) && isShortString(w.branch, 300) && typeof w.path === 'string' && SHELL_INERT_PATH.test(w.path), 'enrichment.worktrees: a path that is unsafe inside a command');
  }

  need(Array.isArray(payload.problems) && payload.problems.length <= 500 && payload.problems.every(isObject), 'problems');
  need(nullOr((v) => isShortString(v, 200))(payload.pushedFrom ?? null), 'pushedFrom');
  need(nullOr((v) => isShortString(v, 40))(payload.pluginVersion ?? null), 'pluginVersion');
  return bytes;
}

/** Every blob a payload refers to: sha256 -> declared size. */
export function manifestOf(payload) {
  const manifest = new Map();
  for (const plan of Object.values(payload.plans)) manifest.set(plan.sha256, null); // `bytes` is the file's size, not the cut text's
  for (const files of Object.values(payload.attachments)) for (const file of files) manifest.set(file.sha256, file.bytes);
  if (payload.summary) manifest.set(payload.summary.sha256, payload.summary.bytes);
  return manifest;
}

// -- compare ----------------------------------------------------------------------

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  // Sorted, because JSON.parse moves integer-like keys to the front and a hash must not care.
  return Object.fromEntries(Object.keys(value).filter((key) => !UNHASHED.has(key)).sort().map((key) => [key, canonical(value[key])]));
}

/** Equal for two pushes of an unchanged cycle, whenever and from wherever they were made. */
export function canonicalHash(payload) {
  return sha256(JSON.stringify(canonical(payload)));
}

// -- and back ---------------------------------------------------------------------

/**
 * @param {object} payload   as validated
 * @param {object} [options]
 * @param {(sha256: string) => string|undefined} options.text  blob text by hash; undefined when the blob never arrived
 * @param {(sha256: string) => boolean} [options.has]  whether a blob arrived, for the ones whose text is not needed here
 * @param {object} [options.cycle]  fields to lay over `raw.cycle` (the server adds uuid, pushedAt, readOnly, ...)
 * @returns {object} RawCycle
 */
export function rawFromPayload(payload, { text = () => undefined, has = () => true, cycle = {} } = {}) {
  const problems = [...payload.problems];
  const incomplete = [];

  const plans = {};
  for (const [id, plan] of Object.entries(payload.plans)) {
    const markdown = text(plan.sha256);
    if (markdown === undefined) { incomplete.push(`the plan of ${id}`); continue; }
    plans[id] = { bytes: plan.bytes, mtimeMs: plan.mtimeMs, markdown };
  }

  for (const [id, files] of Object.entries(payload.attachments)) for (const file of files) if (!has(file.sha256)) incomplete.push(`${file.name} of ${id}`);
  if (payload.summary && !has(payload.summary.sha256)) incomplete.push('the cycle notes');

  if (incomplete.length) {
    problems.push({
      code: 'push-incomplete',
      subject: 'push',
      message: `The last push did not finish: ${incomplete.slice(0, 5).join(', ')}${incomplete.length > 5 ? ` and ${incomplete.length - 5} more` : ''} never arrived. The next push repairs it.`,
      since: null,
      usingLastGood: false,
    });
  }

  return {
    cycle: { id: 'live', isArchive: false, dir: null, indexFile: payload.cycle.indexFile ?? null, slug: payload.cycle.slug ?? null, stateFiles: payload.cycle.indexFile ? [payload.cycle.indexFile] : [], ...cycle },
    index: payload.index,
    batchFiles: payload.batchFiles,
    locks: payload.locks,
    plans,
    // The type is worked out again from the name: what the sender believed is never trusted.
    attachments: Object.fromEntries(Object.entries(payload.attachments).map(([id, files]) => [id, files.map((f) => ({ name: f.name, type: attachmentType(f.name), bytes: f.bytes }))])),
    summaryFile: payload.summary?.file ?? null,
    config: payload.config,
    problems,
    // Not part of what read.mjs produces: pull request and worktree state as the laptop saw it,
    // for whoever builds the model to pass on as `enrichment`.
    enrichment: payload.enrichment ?? null,
  };
}
