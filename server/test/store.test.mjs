// The Postgres HumanStore: the same contract the file store passes, then what
// only a store with users and projects can get wrong.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { openCycleFrom } from '../../scripts/report/cycle.mjs';
import { blocksClaim } from '../../scripts/report/gate.mjs';
import { createReader } from '../../scripts/report/read.mjs';
import { NOW, humanStoreContract } from '../../test/contracts/human-store.mjs';
import { specs } from '../../test/fixtures/specs.mjs';
import { materializeTemp } from '../../test/helpers/cycle.mjs';
import { importLocalHumanState } from '../import-local.mjs';
import { createPgHumanStore } from '../store-pg.mjs';
import { testDb } from './helpers/db.mjs';
import { bareCycle, seedProject, seedUser } from './helpers/seed.mjs';

const rejects = (promise, status) => assert.rejects(promise, (error) => error.status === status);
const readJson = (path) => readFile(path, 'utf8').then(JSON.parse).catch(() => null);

/** A fixture on disk for the pipeline side, with everything people recorded moved into Postgres. */
async function open(spec, now, { actorRole = 'developer' } = {}) {
  const t = await testDb();
  const dir = await materializeTemp(spec, now);
  const { projectId, user } = await seedProject(t.db, { role: actorRole });
  const cycleUuid = await bareCycle(t.db, { projectId, userId: user.id });
  const imported = await importLocalHumanState(t.db, {
    projectId, userId: user.id, cycleUuid,
    answersJson: await readJson(join(dir, 'answers.json')),
    ticksJson: await readJson(join(dir, `report-inbox.${spec.slug}.json`)),
  });

  const storeFor = (actor) => createPgHumanStore(t.db, { projectId, cycleUuid, actor });
  const cycle = openCycleFrom({ reader: createReader(dir), humanFor: (_raw, actor) => storeFor(actor ?? user) });
  return { t, dir, projectId, user, cycleUuid, imported, storeFor, cycle, close: async () => { await t.close(); await rm(dir, { recursive: true, force: true }); } };
}

humanStoreContract('postgres', open);

describe('postgres: who is writing', () => {
  const ID = 'question:qs101:q-cover-ratio';

  test('nobody signed in can read and cannot write', async () => {
    const o = await open(specs.questions, NOW);
    try {
      const { model } = await o.cycle.build({ now: NOW });
      const anonymous = createPgHumanStore(o.t.db, { projectId: o.projectId, cycleUuid: o.cycleUuid, actor: null });
      assert.ok(Object.keys((await anonymous.load()).items).length > 0);
      await rejects(anonymous.addAnswer(model.inbox[ID], { body: 'Square.' }), 403);
      await rejects(anonymous.setResolution(model.inbox[ID], { resolution: 'sent' }), 403);
      await rejects(anonymous.confirm(model.inbox[ID]), 403);
    } finally {
      await o.close();
    }
  });

  test('an archived cycle takes no writes', async () => {
    const o = await open(specs.questions, NOW);
    try {
      const { model } = await o.cycle.build({ now: NOW });
      const archived = createPgHumanStore(o.t.db, { projectId: o.projectId, cycleUuid: o.cycleUuid, isArchive: true, actor: o.user });
      await rejects(archived.addAnswer(model.inbox[ID], { body: 'Square.' }), 403);
    } finally {
      await o.close();
    }
  });

  test('an answerer\'s answer is a proposal: stored, never loaded, and the gate stays shut', async () => {
    const o = await open(specs.questions, NOW);
    try {
      const answerer = await seedUser(o.t.db, o.projectId, { login: 'mara', role: 'answerer' });
      const { model } = await o.cycle.build({ now: NOW });
      await o.storeFor(answerer).addAnswer(model.inbox[ID], { body: 'Square, please.', idempotencyKey: 'p-1' });

      const after = (await o.cycle.build({ now: NOW })).model.inbox[ID];
      assert.deepEqual([after.state, after.answer, after.answers.length], ['open', null, 0]);
      assert.equal(blocksClaim(after), true);
      const stored = await o.t.db.query('select body, accepted_at, created_by from answer where idempotency_key = $1', ['p-1']);
      assert.deepEqual([stored.rows[0].body, stored.rows[0].accepted_at, String(stored.rows[0].created_by)], ['Square, please.', null, String(answerer.id)]);

      // The proposal is invisible, so it must not be "the newest answer" a developer is told they missed.
      await o.storeFor(o.user).addAnswer(after, { body: 'Square.', previousAnswerId: null });
      assert.equal((await o.cycle.build({ now: NOW })).model.inbox[ID].state, 'handled');
    } finally {
      await o.close();
    }
  });

  test('a row nobody accepted never opens the gate, however it got there', async () => {
    const o = await open(specs.questions, NOW);
    try {
      await o.t.db.query("insert into answer (public_id, project_id, task_id, key, body) values ('feedfacecafe', $1, 'qs101', 'q-cover-ratio', 'Planted.')", [o.projectId]);
      const item = (await o.cycle.build({ now: NOW })).model.inbox[ID];
      assert.deepEqual([item.state, item.answers.length], ['open', 0]);
      assert.equal(blocksClaim(item), true);
    } finally {
      await o.close();
    }
  });

  test('two people saving at once against the same view: one answer, one 409', async () => {
    const o = await open(specs.questions, NOW);
    try {
      const second = await seedUser(o.t.db, o.projectId, { login: 'lee' });
      const { model } = await o.cycle.build({ now: NOW });
      const results = await Promise.allSettled([
        o.storeFor(o.user).addAnswer(model.inbox[ID], { body: 'Square.', previousAnswerId: null }),
        o.storeFor(second).addAnswer(model.inbox[ID], { body: 'Portrait.', previousAnswerId: null }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
      assert.equal((await o.cycle.build({ now: NOW })).model.inbox[ID].answers.length, 1);
    } finally {
      await o.close();
    }
  });

  test('every write moves the project\'s revision and leaves an audit row naming the writer', async () => {
    const o = await open(specs.questions, NOW);
    try {
      const rev = async () => Number((await o.t.db.query('select human_rev from project where id = $1', [o.projectId])).rows[0].human_rev);
      const before = await rev();
      const { model } = await o.cycle.build({ now: NOW });
      await o.cycle.human.addAnswer(model.inbox[ID], { body: 'Square.' });
      await rejects(o.cycle.human.addAnswer(model.inbox[ID], { body: '   ' }), 400);
      assert.equal(await rev(), before + 1, 'a refused write rolls its bump back');

      const log = await o.t.db.query("select user_id, action, payload from audit_log where action = 'answer'");
      assert.deepEqual(log.rows.map((r) => [String(r.user_id), r.payload.item]), [[String(o.user.id), ID]]);
    } finally {
      await o.close();
    }
  });

  test('a project sees only its own answers, even for the same task and key', async () => {
    const o = await open(specs.questions, NOW);
    try {
      const other = await seedProject(o.t.db, { project: 'other', login: 'pat' });
      const { model } = await o.cycle.build({ now: NOW });
      await o.cycle.human.addAnswer(model.inbox[ID], { body: 'Square.' });

      const theirs = createPgHumanStore(o.t.db, { projectId: other.projectId, cycleUuid: null, actor: other.user });
      assert.deepEqual((await theirs.load()).items, {});
      await theirs.addAnswer(model.inbox[ID], { body: 'Portrait, for the other shop.', previousAnswerId: null });
      assert.equal((await o.cycle.build({ now: NOW })).model.inbox[ID].answer.body, 'Square.');
      assert.equal((await theirs.load()).items[ID].answers[0].body, 'Portrait, for the other shop.');
    } finally {
      await o.close();
    }
  });
});

describe('the one-time import', () => {
  test('brings in every question with its history, under the importer\'s name', async () => {
    const o = await open(specs.questions, NOW);
    try {
      assert.deepEqual([o.imported.questions.imported, o.imported.questions.skipped, o.imported.answers], [4, [], 3]);
      const rows = await o.t.db.query('select public_id, accepted_by, created_by, created_at from answer order by id');
      assert.deepEqual(rows.rows.map((r) => r.public_id), ['seedqs1050', 'seedqs1060', 'seedqs1020'], 'ids survive, so an open tab\'s "newest I saw" still matches');
      assert.ok(rows.rows.every((r) => String(r.accepted_by) === String(o.user.id) && String(r.created_by) === String(o.user.id)));
      assert.equal(rows.rows[2].created_at.toISOString(), '2026-01-20T10:00:00.000Z', 'and so do their dates');
    } finally {
      await o.close();
    }
  });

  test('again imports nothing; a question already on the server is left alone and listed', async () => {
    const o = await open(specs.questions, NOW);
    try {
      const answersJson = structuredClone(specs.questions.answers);
      answersJson.items['question:qs104:q-new'] = { taskId: 'qs104', key: 'q-new', resolution: 'sent', fingerprint: 'f', title: 'New', text: 'New?', note: '', at: '2026-02-03T09:30:00.000Z', answers: [] };
      answersJson.items['question:qs105:q-slip-logo'].answers[0].body = 'A different answer, from a second laptop.';

      const again = await importLocalHumanState(o.t.db, { projectId: o.projectId, userId: o.user.id, cycleUuid: o.cycleUuid, answersJson, ticksJson: null });
      assert.equal(again.questions.imported, 1, 'only the question the server had never heard of');
      assert.equal(again.questions.skipped.length, 4);
      assert.ok(again.questions.skipped.every((s) => s.reason === 'already recorded on the server'));
      const kept = await o.t.db.query("select body from answer where task_id = 'qs105'");
      assert.deepEqual(kept.rows.map((r) => r.body), ['Use the **full wordmark**, top left.'], 'never merged within a question');
    } finally {
      await o.close();
    }
  });

  test('what it will not bring in: "answered" with no answer, oversize text, a tick on a question', async () => {
    const t = await testDb();
    try {
      const { projectId, user } = await seedProject(t.db);
      const cycleUuid = await bareCycle(t.db, { projectId, userId: user.id });
      const entry = (extra) => ({ taskId: 't1', key: 'k', resolution: 'sent', fingerprint: 'f', title: 'T', text: 'Q?', note: '', at: '2026-02-03T09:30:00.000Z', answers: [], ...extra });
      const report = await importLocalHumanState(t.db, {
        projectId, userId: user.id, cycleUuid,
        answersJson: { items: {
          'question:t1:hollow': entry({ key: 'hollow', resolution: 'answered' }),
          'question:t1:long': entry({ key: 'long', resolution: 'answered', answers: [{ id: 'a', body: 'x'.repeat(8001) }] }),
          'question:../x:k': entry({ taskId: '../x' }),
          'question:t1:fine': entry({ key: 'fine' }),
        } },
        ticksJson: { items: {
          'question:t1:hollow': { resolution: 'answered' },
          'verify-close:t1:fixed': { resolution: 'verified', fingerprint: 'f', title: 'T', note: 'n'.repeat(2500) },
        } },
      });
      assert.deepEqual(report.questions.skipped.map((s) => s.reason).sort(), ['an answer is empty or too long', 'marked answered, but holds no answer', 'no usable task id']);
      assert.deepEqual([report.questions.imported, report.ticks], [1, { imported: 1, skipped: 1 }]);
      assert.equal((await t.db.query('select length(note) as n from inbox_tick')).rows[0].n, 2000);
      assert.equal((await t.db.query("select count(*)::int as n from audit_log where action = 'import-local'")).rows[0].n, 1);
    } finally {
      await t.close();
    }
  });

  test('a cycle of another project cannot be named', async () => {
    const t = await testDb();
    try {
      const a = await seedProject(t.db, { project: 'alpha', login: 'ann' });
      const b = await seedProject(t.db, { project: 'beta', login: 'bob' });
      const theirs = await bareCycle(t.db, { projectId: b.projectId, userId: b.user.id });
      await rejects(importLocalHumanState(t.db, { projectId: a.projectId, userId: a.user.id, cycleUuid: theirs, ticksJson: { items: {} } }), 404);
    } finally {
      await t.close();
    }
  });
});
