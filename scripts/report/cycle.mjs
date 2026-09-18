// One way to turn a cycle into a view model: read it, load what people recorded,
// build. The report server and the `taskflow` CLI both go through here, so the
// page and the claim gate can never disagree about a batch. The hosted server
// goes through `openCycleFrom` with Postgres behind both arguments.

import { createHumanStore } from './human.mjs';
import { buildModel } from './model.mjs';
import { createReader } from './read.mjs';

/**
 * @param {object} from
 * @param {{read: () => Promise<object>}} from.reader  produces a RawCycle
 * @param {(raw: object, actor?: object|null) => object} from.humanFor
 *   the HumanStore for that cycle. Whether the same store is handed out twice is
 *   this function's business: a file store must be (its write queue lives in the
 *   instance), a database store must not be (the live cycle changes under it).
 */
export function openCycleFrom({ reader, humanFor }) {
  let lastRaw = null;

  return {
    reader,
    /** The store of the cycle as last built; null before the first build. */
    get human() { return lastRaw ? humanFor(lastRaw, null) : null; },
    /** The same, on behalf of a signed-in writer. */
    humanAs(actor) { return lastRaw ? humanFor(lastRaw, actor) : null; },

    /** @param {object} [options] `enrichment` may be a function of the RawCycle */
    async build({ enrichment = null, now = Date.now() } = {}) {
      const raw = await reader.read();
      lastRaw = raw;
      const records = await humanFor(raw, null).load(raw.index?.last_triage ?? null);
      const model = buildModel(raw, { human: records, enrichment: typeof enrichment === 'function' ? enrichment(raw) : enrichment, now });
      return { raw, records, model };
    },
  };
}

/**
 * @param {object} where
 * @param {string} where.root   the output directory
 * @param {string} [where.dir]  the cycle to show: `root` (live) or an archive under it
 */
export function openCycle({ root, dir = root, slug = null, cycleId = 'live', isArchive = false, config = null }) {
  const reader = createReader(dir, { slug: isArchive ? null : slug, cycleId, isArchive, config });
  let human = null;
  // The slug comes from the index file that was found, so the store waits for the first read.
  return openCycleFrom({ reader, humanFor: (raw) => (human ??= createHumanStore({ root, cycleDir: dir, slug: raw.cycle.slug, isArchive })) });
}
