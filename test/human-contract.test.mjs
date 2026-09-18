// The HumanStore contract, on files.

import { rm } from 'node:fs/promises';
import { openCycle } from '../scripts/report/cycle.mjs';
import { humanStoreContract } from './contracts/human-store.mjs';
import { materializeTemp } from './helpers/cycle.mjs';

humanStoreContract('files', async (spec, now) => {
  const dir = await materializeTemp(spec, now);
  return { cycle: openCycle({ root: dir }), close: () => rm(dir, { recursive: true, force: true }) };
});
