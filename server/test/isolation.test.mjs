// Two projects in one database. Content-addressed storage is where tenants leak
// into each other: a hash is a name anyone can say.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { buildModel } from '../../scripts/report/model.mjs';
import { sha256 } from '../../scripts/report/payload.mjs';
import { specs } from '../../test/fixtures/specs.mjs';
import { NOW, roundTrip } from '../../test/helpers/trip.mjs';
import { ingestCycle, putBlob } from '../ingest.mjs';
import { createPgSource } from '../source-pg.mjs';
import { testDb } from './helpers/db.mjs';
import { push } from './helpers/push.mjs';
import { seedProject } from './helpers/seed.mjs';

const SECRET_PLAN = '# The other shop\'s plan\n\nNobody outside project beta may read this.\n';

describe('project alpha cannot read project beta', () => {
  let t;
  let trip;
  let alpha;
  let beta;
  let betaPlanHash;

  before(async () => {
    t = await testDb();
    trip = await roundTrip(specs.questions);
    alpha = await seedProject(t.db, { project: 'alpha', login: 'ann' });
    beta = await seedProject(t.db, { project: 'beta', login: 'bob' });

    // Beta pushes a cycle whose qs101 plan is the secret.
    const body = Buffer.from(SECRET_PLAN);
    betaPlanHash = sha256(body);
    const payload = { ...structuredClone(trip.wire), cycle: { ...trip.wire.cycle, id: randomUUID() } };
    payload.plans.qs101 = { ...payload.plans.qs101, sha256: betaPlanHash };
    const blobs = new Map([...trip.blobs, [betaPlanHash, { bytes: body.length, read: async () => body }]]);
    await push(t.db, { projectId: beta.projectId, userId: beta.user.id, payload, blobs });
  });
  after(async () => { await t.close(); await rm(trip.dir, { recursive: true, force: true }); });

  test('beta reads its own plan', async () => {
    const raw = await createPgSource(t.db, { projectId: beta.projectId, ownerId: beta.user.id }).reader('live').read();
    assert.equal(raw.plans.qs101.markdown, SECRET_PLAN);
  });

  test('a source for alpha finds nothing of beta\'s, whoever the owner is said to be', async () => {
    for (const ownerId of [alpha.user.id, beta.user.id]) {
      const source = createPgSource(t.db, { projectId: alpha.projectId, ownerId });
      assert.equal((await source.reader('live').read()).index, null);
      assert.deepEqual(await source.listCycles(), [{ id: 'live', isArchive: false }]);
    }
  });

  test('alpha names beta\'s hash in its own manifest: told it is missing, and never handed the bytes', async () => {
    const forged = structuredClone(trip.wire);
    forged.plans.qs101 = { ...forged.plans.qs101, sha256: betaPlanHash };
    forged.attachments = { qs101: [{ name: 'plan.png', bytes: Buffer.byteLength(SECRET_PLAN), sha256: betaPlanHash }] };

    const { missing } = await ingestCycle(t.db, { projectId: alpha.projectId, userId: alpha.user.id, payload: forged });
    assert.ok(missing.includes(betaPlanHash), 'no oracle: alpha cannot learn that beta holds this file');

    const source = createPgSource(t.db, { projectId: alpha.projectId, ownerId: alpha.user.id });
    const raw = await source.reader('live').read();
    assert.equal(raw.plans.qs101, undefined);
    assert.equal(await source.attachment('live', 'qs101', 'plan.png'), null);
    assert.ok(buildModel(raw, { now: NOW }).health.problems.some((p) => p.code === 'push-incomplete'));
  });

  test('not even after beta\'s copy has been read and cached in this process', async () => {
    const betaSource = createPgSource(t.db, { projectId: beta.projectId, ownerId: beta.user.id });
    await betaSource.reader('live').read();
    const alphaSource = createPgSource(t.db, { projectId: alpha.projectId, ownerId: alpha.user.id });
    assert.equal((await alphaSource.reader('live').read()).plans.qs101, undefined);
  });

  test('alpha can only get the content by already having it, which leaks nothing', async () => {
    await putBlob(t.db, { projectId: alpha.projectId, sha256: betaPlanHash, body: Buffer.from(SECRET_PLAN) });
    const held = await t.db.query('select project_id from blob where sha256 = $1 order by 1', [betaPlanHash]);
    assert.deepEqual(held.rows.map((r) => r.project_id), ['alpha', 'beta'], 'one copy each; neither can delete or replace the other\'s');
  });

  test('deleting a project takes its cycles, blobs and answers with it, and nobody else\'s', async () => {
    await t.db.query("delete from project where id = 'alpha'");
    const left = await t.db.query('select (select count(*) from cycle)::int as cycles, (select count(*) from blob where project_id = $1)::int as alpha_blobs, (select count(*) from blob where project_id = $2)::int as beta_blobs', ['alpha', 'beta']);
    assert.deepEqual([left.rows[0].cycles, left.rows[0].alpha_blobs], [1, 0]);
    assert.ok(left.rows[0].beta_blobs > 0);
  });
});
