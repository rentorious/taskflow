// One way to turn a cycle directory into a view model: read the files, load what
// the developer recorded, build. The report server and the `taskflow` CLI both go
// through here, so the page and the claim gate can never disagree about a batch.

import { createHumanStore } from './human.mjs';
import { buildModel } from './model.mjs';
import { createReader } from './read.mjs';

/**
 * @param {object} where
 * @param {string} where.root   the output directory
 * @param {string} [where.dir]  the cycle to show: `root` (live) or an archive under it
 */
export function openCycle({ root, dir = root, slug = null, cycleId = 'live', isArchive = false, config = null }) {
  const reader = createReader(dir, { slug: isArchive ? null : slug, cycleId, isArchive, config });
  let human = null;

  return {
    reader,
    /** Available after the first build: the slug comes from the index file that was found. */
    get human() { return human; },

    /** @param {object} [options] `enrichment` may be a function of the RawCycle */
    async build({ enrichment = null, now = Date.now() } = {}) {
      const raw = await reader.read();
      human ??= createHumanStore({ root, cycleDir: dir, slug: raw.cycle.slug, isArchive });
      const records = await human.load(raw.index?.last_triage ?? null);
      const model = buildModel(raw, { human: records, enrichment: typeof enrichment === 'function' ? enrichment(raw) : enrichment, now });
      return { raw, records, model };
    },
  };
}
