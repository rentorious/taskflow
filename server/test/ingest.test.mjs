import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { buildModel } from '../../scripts/report/model.mjs';
import { sha256 } from '../../scripts/report/payload.mjs';
import { specs } from '../../test/fixtures/specs.mjs';
import { NOW, roundTrip } from '../../test/helpers/trip.mjs';
import { ingestCycle, putBlob } from '../ingest.mjs';
import { createPgSource } from '../source-pg.mjs';
import { testDb } from './helpers/db.mjs';
import { push } from './helpers/push.mjs';
import { seedProject, seedUser } from './helpers/seed.mjs';

const rejects = (promise, status) => assert.rejects(promise, (error) => error.status === status);

/** A fixture turned into a payload and blobs, with a database to push it into. */
async function setup(spec = specs.questions, options = {}) {
  const t = await testDb();
  const trip = await roundTrip(spec, options);
  const { projectId, user } = await seedProject(t.db);
  return { t, trip, projectId, user, payload: trip.wire, blobs: trip.blobs, close: async () => { await t.close(); await rm(trip.dir, { recursive: true, force: true }); } };
}

const cycleRow = async (db, id) => (await db.query('select is_live, archived_as, rev::int as rev, pushed_at from cycle where id = $1', [id])).rows[0];

describe('a push', () => {
  test('asks for every blob the first time, for none the second, and changes nothing by being repeated', async () => {
    const s = await setup();
    try {
      const first = await push(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload, blobs: s.blobs });
      assert.deepEqual([first.changed, first.missing.length, first.archived], [true, s.blobs.size, null]);
      const before = await cycleRow(s.t.db, first.cycleUuid);

      const again = await push(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: { ...s.payload, pushedFrom: 'another-laptop' }, blobs: s.blobs });
      assert.deepEqual([again.changed, again.missing], [false, []]);
      const after = await cycleRow(s.t.db, first.cycleUuid);
      assert.equal(after.rev, before.rev, 'an unchanged push repaints nobody');
      assert.ok(after.pushed_at >= before.pushed_at, 'but the mirror knows it is fresh');
      assert.equal((await s.t.db.query("select count(*)::int as n from audit_log where action = 'push'")).rows[0].n, 1);
    } finally {
      await s.close();
    }
  });

  test('a standing problem keeps the date it was first seen, so repeating a push repaints nobody', async () => {
    const s = await setup(specs['kitchen-sink']);
    try {
      assert.ok(s.payload.problems.some((p) => p.since), 'the fixture has an unreadable batch file, dated by the read');
      const source = createPgSource(s.t.db, { projectId: s.projectId, ownerId: s.user.id });
      await push(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload, blobs: s.blobs });
      const first = buildModel(await source.reader('live').read(), { now: NOW });

      const later = structuredClone(s.payload);
      for (const problem of later.problems) if (problem.since) problem.since = '2030-01-01T00:00:00.000Z';
      const again = await ingestCycle(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: later });
      const second = buildModel(await source.reader('live').read(), { now: NOW });
      assert.deepEqual([again.changed, second.version], [false, first.version]);
      assert.deepEqual(second.health.problems.map((p) => p.since), first.health.problems.map((p) => p.since));
    } finally {
      await s.close();
    }
  });

  test('a change moves the revision, and only new blobs are asked for', async () => {
    const s = await setup();
    try {
      const first = await push(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload, blobs: s.blobs });
      const changedPayload = structuredClone(s.payload);
      changedPayload.batchFiles['batch-2'].data.status = 'in-progress';
      const body = Buffer.from('# A rewritten plan\n');
      changedPayload.plans.qs102 = { ...changedPayload.plans.qs102, sha256: sha256(body) };

      const second = await ingestCycle(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: changedPayload });
      assert.deepEqual([second.changed, second.missing], [true, [sha256(body)]]);
      assert.equal((await cycleRow(s.t.db, first.cycleUuid)).rev, 2 + s.blobs.size, 'one for the push, one per blob that arrived, one for the change');
    } finally {
      await s.close();
    }
  });

  test('a blob is hashed again on arrival, capped, and only taken when a pushed cycle asked for it', async () => {
    const s = await setup();
    try {
      const { missing } = await ingestCycle(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload });
      const wanted = missing[0];
      await rejects(putBlob(s.t.db, { projectId: s.projectId, sha256: wanted, body: Buffer.from('not what the name says') }), 400);
      await rejects(putBlob(s.t.db, { projectId: s.projectId, sha256: sha256(Buffer.from('uninvited')), body: Buffer.from('uninvited') }), 404);
      const big = Buffer.alloc(10 * 1024 * 1024 + 1);
      await rejects(putBlob(s.t.db, { projectId: s.projectId, sha256: sha256(big), body: big }), 413);
      await rejects(putBlob(s.t.db, { projectId: s.projectId, sha256: wanted, body: 'a string' }), 400);

      const real = await s.blobs.get(wanted).read();
      assert.deepEqual(await putBlob(s.t.db, { projectId: s.projectId, sha256: wanted, body: real }), { stored: true });
      assert.deepEqual(await putBlob(s.t.db, { projectId: s.projectId, sha256: wanted, body: real }), { stored: false });
    } finally {
      await s.close();
    }
  });

  test('an upload that stopped half way shows as unfinished, and the next push heals it', async () => {
    const s = await setup();
    try {
      const planHash = s.payload.plans.qs101.sha256;
      await push(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload, blobs: s.blobs, only: (hash) => hash !== planHash });
      const source = createPgSource(s.t.db, { projectId: s.projectId, ownerId: s.user.id });
      const before = await source.signature('live');
      const broken = buildModel(await source.reader('live').read(), { now: NOW });
      assert.deepEqual(broken.health.problems.map((p) => p.code).sort(), ['plan-missing', 'push-incomplete'], 'said twice: the plan is not here, and why');
      assert.equal(broken.tasks.qs101.plan.exists, false);

      const healed = await push(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload, blobs: s.blobs });
      assert.deepEqual([healed.changed, healed.uploaded], [false, [planHash]]);
      assert.notEqual(await source.signature('live'), before, 'the arrival repaints the page');
      assert.deepEqual(buildModel(await source.reader('live').read(), { now: NOW }).health.problems, []);
    } finally {
      await s.close();
    }
  });

  test('a new cycle id archives the one before it, under the name clean would have used', async () => {
    const s = await setup();
    try {
      const first = await push(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload, blobs: s.blobs });
      const next = (id) => ({ ...structuredClone(s.payload), cycle: { ...s.payload.cycle, id } });

      const second = await ingestCycle(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: next(randomUUID()) });
      assert.equal(second.archived, '2026-02-02');
      const third = await ingestCycle(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: next(randomUUID()) });
      assert.equal(third.archived, '2026-02-02-2', 'two cycles triaged the same day');

      assert.deepEqual(await cycleRow(s.t.db, first.cycleUuid).then((r) => [r.is_live, r.archived_as]), [false, '2026-02-02']);
      const source = createPgSource(s.t.db, { projectId: s.projectId, ownerId: s.user.id });
      assert.deepEqual((await source.listCycles()).map((c) => c.id).sort(), ['2026-02-02', '2026-02-02-2', 'live']);
      const archived = await source.reader('2026-02-02').read();
      assert.deepEqual([archived.cycle.isArchive, archived.cycle.uuid, Object.keys(archived.plans).length], [true, first.cycleUuid, 6]);

      await rejects(ingestCycle(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload }), 409);
    } finally {
      await s.close();
    }
  });

  test('two laptops pushing a first cycle at the same moment: one live cycle, no error', async () => {
    const s = await setup();
    try {
      const other = { ...structuredClone(s.payload), cycle: { ...s.payload.cycle, id: randomUUID() } };
      const results = await Promise.all([
        ingestCycle(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload }),
        ingestCycle(s.t.open(), { projectId: s.projectId, userId: s.user.id, payload: other }),
      ]);
      assert.equal(results.filter((r) => r.archived).length, 1, 'whoever came second archived the first');
      assert.equal((await s.t.db.query('select count(*)::int as n from cycle where is_live')).rows[0].n, 1);
    } finally {
      await s.close();
    }
  });
});

describe('who may push what', () => {
  test('a cycle id is only honoured with its owner: another user, or another project, gets "no such project"', async () => {
    const s = await setup();
    try {
      await push(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: s.payload, blobs: s.blobs });
      const colleague = await seedUser(s.t.db, s.projectId, { login: 'lee' });
      const elsewhere = await seedProject(s.t.db, { project: 'other', login: 'pat' });
      const hijack = structuredClone(s.payload);
      hijack.index.tasks.qs101.name = 'Overwritten';

      await rejects(ingestCycle(s.t.db, { projectId: s.projectId, userId: colleague.id, payload: hijack }), 404);
      await rejects(ingestCycle(s.t.db, { projectId: elsewhere.projectId, userId: elsewhere.user.id, payload: hijack }), 404);
      const kept = (await s.t.db.query('select snapshot from cycle where id = $1', [s.payload.cycle.id])).rows[0].snapshot;
      assert.notEqual(kept.index.tasks.qs101.name, 'Overwritten');
    } finally {
      await s.close();
    }
  });

  test('not a member, or only an answerer: nothing is stored', async () => {
    const s = await setup();
    try {
      const answerer = await seedUser(s.t.db, s.projectId, { login: 'mara', role: 'answerer' });
      await rejects(ingestCycle(s.t.db, { projectId: s.projectId, userId: answerer.id, payload: s.payload }), 403);
      await rejects(ingestCycle(s.t.db, { projectId: 'nowhere', userId: s.user.id, payload: s.payload }), 404);
      assert.equal((await s.t.db.query('select count(*)::int as n from cycle')).rows[0].n, 0);
    } finally {
      await s.close();
    }
  });

  test('a payload the validator refuses never reaches the database', async () => {
    const s = await setup();
    try {
      const bad = structuredClone(s.payload);
      bad.index.tasks['../etc'] = bad.index.tasks.qs101;
      await rejects(ingestCycle(s.t.db, { projectId: s.projectId, userId: s.user.id, payload: bad }), 400);
      assert.equal((await s.t.db.query('select count(*)::int as n from cycle')).rows[0].n, 0);
    } finally {
      await s.close();
    }
  });
});

test('a project nobody has pushed to is an empty cycle, not an error', async () => {
  const t = await testDb();
  try {
    const { projectId, user } = await seedProject(t.db);
    const source = createPgSource(t.db, { projectId, ownerId: user.id });
    assert.deepEqual(await source.listCycles(), [{ id: 'live', isArchive: false }]);
    const model = buildModel(await source.reader('live').read(), { now: NOW });
    assert.deepEqual([model.cycle.empty, model.cycle.hosted, model.cycle.pushedAt], [true, true, null]);
    assert.equal(await source.summaryText('live'), '');
    assert.equal(await source.attachment('live', 't1', 'a.png'), null);
  } finally {
    await t.close();
  }
});
