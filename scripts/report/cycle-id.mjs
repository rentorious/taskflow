// A cycle's identity on a hosted server: `<output_dir>/cycle.<slug>.json`.
//
// `last_triage` cannot be one: it is a date, triage rewrites it, and two cycles
// can share it. The id is minted here, once, by a script and never by a skill's
// prose. It is an ordinary top-level file, so /taskflow:clean archives it with
// the cycle it names, and the next cycle gets a fresh one. read.mjs ignores it.

import { randomUUID } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listStateFiles } from './read.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function cycleIdFileName(slug) {
  if (!SLUG.test(slug ?? '')) throw new Error(`Not a developer slug: ${slug}`);
  return `cycle.${slug}.json`;
}

/** @returns {Promise<string|null>} null when the cycle has never been given an id */
export async function readCycleId(dir, slug) {
  const path = join(dir, cycleIdFileName(slug));
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let id = null;
  try {
    id = JSON.parse(text)?.cycle_id;
  } catch {
    // Falls through to the refusal below.
  }
  // Minting a new id over a damaged file would orphan everything the server holds for this cycle.
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error(`${path} does not hold a cycle id. Restore it, or delete it to start this cycle afresh on the server.`);
  return id;
}

/** The cycle's id, minted on first use. Safe to call from two processes at once. */
export async function ensureCycleId(dir, slug) {
  const existing = await readCycleId(dir, slug);
  if (existing) return existing;

  // An id file with no index beside it would read as a live cycle to /taskflow:clean.
  const hasIndex = (await listStateFiles(dir)).some((s) => s.slug === slug);
  if (!hasIndex) throw new Error(`No state.${slug}.json in ${dir}: there is no cycle to name.`);

  const path = join(dir, cycleIdFileName(slug));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ cycle_id: randomUUID(), created_at: new Date().toISOString() }, null, 2)}\n`);
  try {
    // A hard link either appears whole or fails: whoever loses the race reads the winner's id, never half a file.
    await link(temp, path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await rm(temp, { force: true });
  }
  return readCycleId(dir, slug);
}
