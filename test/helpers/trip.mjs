// A fixture, read once, sent through a payload and back. Shared by the payload
// tests and by the hosted server's parity tests, which put a database in the middle.

import { openCycle } from '../../scripts/report/cycle.mjs';
import { buildModel } from '../../scripts/report/model.mjs';
import { buildPayload, rawFromPayload } from '../../scripts/report/payload.mjs';
import { materializeTemp } from './cycle.mjs';

export const NOW = Date.UTC(2026, 1, 4, 12, 0, 0);
export const CYCLE_ID = '3f2a8c1e-5b7d-4e9a-8c1f-2d3e4f5a6b7c';
export const CONFIG = { projectName: 'Harbor Books', baseBranch: 'dev', providerComments: false, providerEnrichment: false };

/** What a model may differ in when the same cycle comes back from a server: where it was read, and its hash. */
export function comparable(model) {
  const copy = JSON.parse(JSON.stringify(model));
  delete copy.version;
  delete copy.generatedAt;
  for (const key of ['dir', 'hosted', 'uuid', 'pushedAt', 'pushedFrom']) delete copy.cycle[key];
  return copy;
}

/** Read a materialised fixture once, push it through a payload and back, and build both models. */
export async function roundTrip(spec, { now = NOW, cycleId = CYCLE_ID, store = null } = {}) {
  const dir = await materializeTemp(spec, now);
  const { raw, records } = await openCycle({ root: dir, config: CONFIG }).build({ now });
  const enrichment = spec.enrichment ?? null;
  const built = await buildPayload({ raw, cycleId, enrichment, host: 'laptop', pluginVersion: 'test' });

  const wire = JSON.parse(JSON.stringify(built.payload));
  const texts = new Map();
  for (const [hash, blob] of built.blobs) texts.set(hash, (await blob.read()).toString('utf8'));
  // A `store` puts something real in the middle (the hosted server's database) and may bring its own records back.
  const stored = store ? await store({ wire, blobs: built.blobs, dir, spec }) : null;
  const back = stored?.raw ?? rawFromPayload(wire, { text: (hash) => texts.get(hash), has: (hash) => texts.has(hash) });

  return {
    dir, raw, records, wire, blobs: built.blobs, back,
    fromFiles: buildModel(raw, { human: records, enrichment, now }),
    fromPayload: buildModel(back, { human: stored?.records ?? records, enrichment: wire.enrichment, now }),
  };
}
