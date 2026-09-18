// All file access for the report. Produces a RawCycle for model.mjs.
//
// triage and implement write their JSON non-atomically while we read, so every
// JSON read is guarded: retry briefly, fall back to the last good copy of that
// one file, and report a non-fatal problem instead of throwing.

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const RETRY_DELAYS_MS = [50, 150];
export const MAX_PLAN_BYTES = 1024 * 1024;
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const ATTACHMENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

export function attachmentType(name) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext ? ATTACHMENT_TYPES[ext] ?? null : null;
}

async function listDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** Every "state.<slug>[...].json" in a cycle directory, as {file, slug}. */
export async function listStateFiles(dir) {
  const entries = await listDir(dir);
  return entries
    .filter((e) => e.isFile() && /^state\..+\.json$/.test(e.name))
    .map((e) => ({ file: e.name, slug: e.name.slice('state.'.length).split('.')[0] }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Walk up from a cycle directory to the project that owns it: the directory
 * holding `.claude/taskflow-config.json` whose `output_dir` points back here.
 */
export function findProject(dir) {
  let current = resolve(dir);
  for (let depth = 0; depth < 12; depth++) {
    const configPath = join(current, '.claude', 'taskflow-config.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        if (config.output_dir && resolve(current, config.output_dir) === resolve(dir)) {
          return {
            root: current,
            config: {
              projectName: config.project_name ?? null,
              baseBranch: config.base_branch ?? null,
              providerComments: config.provider_comments === true,
              providerEnrichment: config.provider_enrichment === true,
            },
          };
        }
      } catch {
        // An unreadable config only costs us the enrichment, never the report.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root: null, config: null };
}

export function createReader(dir, { slug = null, cycleId = 'live', isArchive = false, config = null } = {}) {
  const root = resolve(dir);
  const lastGood = new Map();
  const badSince = new Map();
  const planCache = new Map();

  async function readJson(path, code, subject, problems) {
    let failure = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const data = JSON.parse(await readFile(path, 'utf8'));
        if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
        lastGood.set(path, data);
        badSince.delete(path);
        return { exists: true, data, unreadable: false };
      } catch (error) {
        if (error.code === 'ENOENT') return { exists: false, data: null, unreadable: false };
        failure = error;
        if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    if (!badSince.has(path)) badSince.set(path, new Date().toISOString());
    const fallback = lastGood.get(path) ?? null;
    problems.push({
      code,
      subject,
      message: `${subject} could not be read (${failure.message}).${fallback ? ' Showing the last good copy.' : ''}`,
      since: badSince.get(path),
      usingLastGood: Boolean(fallback),
    });
    return { exists: true, data: fallback, unreadable: true };
  }

  async function pickIndexFile() {
    const states = await listStateFiles(root);
    if (states.length === 0) return { states, chosen: null };
    const wanted = slug ? states.filter((s) => s.slug === slug) : states;
    const pool = wanted.length ? wanted : states;
    // Archives get hand-renamed ("state.<slug>.<note>.json"); prefer the canonical name.
    const chosen = pool.find((s) => s.file === `state.${s.slug}.json`) ?? pool[0];
    return { states, chosen };
  }

  async function readPlans() {
    const plans = {};
    for (const entry of await listDir(join(root, 'tasks'))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -3);
      if (!SAFE_NAME.test(id)) continue;
      const path = join(root, 'tasks', entry.name);
      const info = await statOrNull(path);
      if (!info) continue;
      const cached = planCache.get(path);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.bytes === info.size) { plans[id] = cached; continue; }
      try {
        const text = await readFile(path, 'utf8');
        const plan = { bytes: info.size, mtimeMs: info.mtimeMs, markdown: text.slice(0, MAX_PLAN_BYTES) };
        planCache.set(path, plan);
        plans[id] = plan;
      } catch {
        // Skipped; the model reports it as a missing plan.
      }
    }
    return plans;
  }

  async function readAttachments() {
    const attachments = {};
    for (const entry of await listDir(join(root, 'attachments'))) {
      if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
      const files = [];
      for (const file of await listDir(join(root, 'attachments', entry.name))) {
        const type = file.isFile() && SAFE_NAME.test(file.name) ? attachmentType(file.name) : null;
        if (!type) continue;
        const info = await statOrNull(join(root, 'attachments', entry.name, file.name));
        if (info) files.push({ name: file.name, type, bytes: info.size });
      }
      if (files.length) attachments[entry.name] = files.sort((a, b) => a.name.localeCompare(b.name));
    }
    return attachments;
  }

  async function pickSummaryFile(index) {
    const named = index?.summary_file;
    if (typeof named === 'string' && SAFE_NAME.test(named) && named.endsWith('.md') && (await statOrNull(join(root, named)))) return named;
    let newest = null;
    for (const entry of await listDir(root)) {
      if (!entry.isFile() || !/^triage-.+\.md$/.test(entry.name)) continue;
      const info = await statOrNull(join(root, entry.name));
      if (info && (!newest || info.mtimeMs > newest.mtimeMs)) newest = { name: entry.name, mtimeMs: info.mtimeMs };
    }
    return newest?.name ?? null;
  }

  return {
    dir: root,

    /** @returns {Promise<object>} RawCycle */
    async read() {
      const problems = [];
      const { states, chosen } = await pickIndexFile();
      const indexRead = chosen
        ? await readJson(join(root, chosen.file), 'index-unreadable', chosen.file, problems)
        : { exists: false, data: null };

      const batchFiles = {};
      const locks = {};
      for (const entry of await listDir(join(root, 'batches'))) {
        const path = join(root, 'batches', entry.name);
        if (entry.isDirectory() && entry.name.endsWith('.lock')) {
          const info = await statOrNull(path);
          if (info) locks[entry.name.slice(0, -'.lock'.length)] = { mtimeMs: info.mtimeMs };
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          const key = entry.name.slice(0, -'.json'.length);
          const info = await statOrNull(path);
          const result = await readJson(path, 'batch-unreadable', key, problems);
          batchFiles[key] = { ...result, mtimeMs: info?.mtimeMs ?? null };
        }
      }

      return {
        cycle: {
          id: cycleId,
          isArchive,
          dir: root,
          indexFile: chosen?.file ?? null,
          slug: chosen?.slug ?? slug ?? null,
          stateFiles: states.map((s) => s.file),
        },
        index: indexRead.data,
        batchFiles,
        locks,
        plans: await readPlans(),
        attachments: await readAttachments(),
        summaryFile: await pickSummaryFile(indexRead.data),
        config,
        problems,
      };
    },
  };
}

/** "live" plus every archive/<name>/ that holds a state file, newest first. */
export async function listCycles(dir) {
  const cycles = [{ id: 'live', dir: resolve(dir), isArchive: false }];
  const names = (await listDir(join(dir, 'archive'))).filter((e) => e.isDirectory() && SAFE_NAME.test(e.name)).map((e) => e.name);
  for (const name of names.sort().reverse()) {
    const cycleDir = join(dir, 'archive', name);
    if ((await listStateFiles(cycleDir)).length) cycles.push({ id: name, dir: resolve(cycleDir), isArchive: true });
  }
  return cycles;
}
