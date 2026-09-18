// Persistence for inbox ticks: `report-inbox.<slug>.json` in the cycle directory.
//
// Holds every kind of tick except questions, which live in answers.json and
// outlive the cycle (see human.mjs). Deliberately separate from state.*.json and
// batches/*.json, which belong to triage and implement, so the report can never
// race an implement session. It is not a dotfile, so /taskflow:clean archives
// it together with the cycle it describes.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_NOTE = 2000;

const empty = (slug, cycle) => ({ schema_version: SCHEMA_VERSION, slug, cycle, updated_at: null, items: {} });

export function tickFileName(slug) {
  return `report-inbox.${slug || 'default'}.json`;
}

export function createTickStore(dir, slug, { readOnly = false } = {}) {
  const path = join(dir, tickFileName(slug));
  let queue = Promise.resolve();

  async function load(cycle = null) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return empty(slug, cycle);
    }
    try {
      const data = JSON.parse(text);
      if (!data || typeof data.items !== 'object' || data.items === null) throw new Error('missing items');
      return data;
    } catch {
      // Keep the evidence, then start clean: a corrupt tick file must not take
      // the report down, and must not be silently overwritten either.
      if (!readOnly) await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
      return empty(slug, cycle);
    }
  }

  /** Set or clear one tick. Writes are serialised and atomic (temp + rename). */
  function set(id, tick, cycle = null) {
    if (readOnly) return Promise.reject(Object.assign(new Error('This cycle is archived and read-only.'), { status: 403 }));
    queue = queue.catch(() => {}).then(async () => {
      const data = await load(cycle);
      if (tick === null) {
        delete data.items[id];
      } else {
        data.items[id] = {
          resolution: tick.resolution,
          at: new Date().toISOString(),
          fingerprint: tick.fingerprint,
          title: tick.title,
          note: String(tick.note ?? '').slice(0, MAX_NOTE),
        };
      }
      data.schema_version = SCHEMA_VERSION;
      data.slug = slug;
      if (cycle) data.cycle = cycle;
      data.updated_at = new Date().toISOString();
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
      await rename(temp, path);
      return data;
    });
    return queue;
  }

  return { path, load, set };
}
