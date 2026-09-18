// The test the hosted dashboard stands on: a cycle pushed into Postgres and read
// back builds the same view model as the directory it came from. Every fixture,
// with what people recorded on it imported too.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { specs } from '../../test/fixtures/specs.mjs';
import { comparable, roundTrip } from '../../test/helpers/trip.mjs';
import { importLocalHumanState } from '../import-local.mjs';
import { createPgSource } from '../source-pg.mjs';
import { createPgHumanStore } from '../store-pg.mjs';
import { testDb } from './helpers/db.mjs';
import { push } from './helpers/push.mjs';
import { seedProject } from './helpers/seed.mjs';

const readJson = (path) => readFile(path, 'utf8').then(JSON.parse).catch(() => null);

describe('files and Postgres build the same model', () => {
  for (const name of Object.keys(specs)) {
    test(name, async () => {
      const t = await testDb();
      let trip;
      try {
        const { projectId, user } = await seedProject(t.db);
        trip = await roundTrip(specs[name], {
          store: async ({ wire, blobs, dir, spec }) => {
            const { cycleUuid } = await push(t.db, { projectId, userId: user.id, payload: wire, blobs });
            await importLocalHumanState(t.db, {
              projectId, userId: user.id, cycleUuid,
              answersJson: await readJson(join(dir, 'answers.json')),
              ticksJson: await readJson(join(dir, `report-inbox.${spec.slug}.json`)),
            });
            const raw = await createPgSource(t.db, { projectId, ownerId: user.id, readOnly: false }).reader('live').read();
            const records = await createPgHumanStore(t.db, { projectId, cycleUuid: raw.cycle.uuid, actor: user }).load();
            return { raw, records };
          },
        });

        assert.deepEqual(comparable(trip.fromPayload), comparable(trip.fromFiles));
        assert.deepEqual([trip.fromPayload.cycle.hosted, trip.fromPayload.cycle.dir, typeof trip.fromPayload.cycle.pushedAt], [true, null, 'string']);
        assert.deepEqual(trip.fromPayload.health.problems.filter((p) => p.code === 'push-incomplete'), []);
      } finally {
        await t.close();
        if (trip) await rm(trip.dir, { recursive: true, force: true });
      }
    });
  }
});
