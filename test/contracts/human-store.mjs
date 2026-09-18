// What any HumanStore must do, asked through a built cycle and never through
// its storage. The file store runs this in test/human-contract.test.mjs; the
// hosted server's database store runs the same assertions from server/test/.
//
// `open(spec, now)` resolves to { cycle, close }: `cycle.build({now})` gives
// { raw, records, model } and `cycle.human` is the store, as openCycleFrom does.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { evaluateClaim, EXIT } from '../../scripts/report/gate.mjs';
import { kitchenSink, questions } from '../fixtures/specs.mjs';

export const NOW = Date.UTC(2026, 1, 4, 12, 0, 0);
const rejects = (promise, status) => assert.rejects(promise, (error) => error.status === status);

export function humanStoreContract(name, open) {
  describe(`${name}: questions cycle through the store`, () => {
    let cycle;
    let close;
    let built;
    before(async () => {
      ({ cycle, close } = await open(questions, NOW));
      built = await cycle.build({ now: NOW });
    });
    after(() => close());

    const state = (id) => built.model.inbox[id]?.state;

    test('each question carries its own state', () => {
      assert.equal(state('question:qs101:q-cover-ratio'), 'open');
      assert.equal(state('question:qs101:q-sold-out'), 'waiting', 'sent');
      assert.equal(state('question:qs105:q-slip-logo'), 'handled');
      assert.equal(state('question:qs106:q-author-order'), 'changed', 'answered, then reworded by triage');
    });

    test('the settling answer is rendered; a changed question still shows what was said', () => {
      const answered = built.model.inbox['question:qs105:q-slip-logo'];
      assert.match(answered.answer.bodyHtml, /<strong>full wordmark<\/strong>/);
      assert.equal(answered.answer.source, 'Mara, by phone, 3 Feb');
      const changed = built.model.inbox['question:qs106:q-author-order'];
      assert.equal(changed.answer.body, 'Newest first.');
      assert.equal(changed.answer.askedAs, 'Ask Mara about edition order');
      assert.equal(built.model.inbox['question:qs101:q-cover-ratio'].answer, null);
      assert.deepEqual(built.model.inbox['question:qs101:q-cover-ratio'].options, ['Portrait, 2:3', 'Square']);
    });

    test('lanes follow the answers', () => {
      const lanes = Object.fromEntries(Object.values(built.model.batches).map((b) => [b.key, b.laneReason ? `${b.lane}/${b.laneReason}` : b.lane]));
      assert.deepEqual(lanes, {
        'batch-1': 'blocked/waiting-on-answers',
        'batch-2': 'ready',
        'batch-3': 'blocked/deps',
        'batch-4': 'ready',
        'batch-5': 'ready',
        'batch-6': 'blocked/waiting-on-answers',
      });
      assert.equal(built.model.batches['batch-1'].blockingQuestions, 2, 'the colour question does not block');
    });

    test('answering through the store opens the gate; confirming a reworded one does too', async () => {
      assert.equal(evaluateClaim(built.model, { batchKey: 'batch-6' }).exit, EXIT.QUESTIONS);
      await cycle.human.confirm(built.model.inbox['question:qs106:q-author-order']);
      await cycle.human.addAnswer(built.model.inbox['question:qs101:q-cover-ratio'], { body: 'Square' });
      await cycle.human.addAnswer(built.model.inbox['question:qs101:q-sold-out'], { body: 'Keep them, with a badge.' });

      const next = await cycle.build({ now: NOW });
      assert.equal(evaluateClaim(next.model, { batchKey: 'batch-6' }).exit, EXIT.OK);
      assert.deepEqual(next.model.laneOrder.ready, ['batch-1', 'batch-2', 'batch-4', 'batch-5', 'batch-6']);
      assert.equal(next.model.inbox['question:qs106:q-author-order'].answer.askedAs, 'Ask Mara about edition order', 'the answer keeps the wording it was given for');
    });

    test('an answer whose question is gone stays in the store for the claim to surface', () => {
      assert.equal(built.model.inbox['question:qs102:q-hours-format'], undefined);
      assert.equal(built.records.items['question:qs102:q-hours-format'].answers[0].body, 'am/pm, please.');
    });
  });

  describe(`${name}: what a store refuses`, () => {
    const ID = 'question:qs101:q-cover-ratio';
    let cycle;
    let close;
    before(async () => { ({ cycle, close } = await open(questions, NOW)); });
    after(() => close());

    const item = async () => (await cycle.build({ now: NOW })).model.inbox[ID];

    test('an answer settles the question and records what was asked, word for word', async () => {
      const asked = await item();
      await cycle.human.addAnswer(asked, { body: '  Square.  ', source: 'Mara, by phone', idempotencyKey: 'k-1', previousAnswerId: null });
      const now = await item();
      assert.equal(now.state, 'handled');
      assert.deepEqual([now.answer.body, now.answer.source, now.answer.via], ['Square.', 'Mara, by phone', 'web']);
      assert.match(now.answer.id, /^[0-9a-f]{12}$/, 'the client sends this id back as previousAnswerId');
      assert.equal(now.answer.questionFingerprint, asked.fingerprint);
    });

    test('a retried save adds nothing, even though what it last saw is stale by now', async () => {
      await cycle.human.addAnswer(await item(), { body: 'Square.', idempotencyKey: 'k-1', previousAnswerId: null });
      assert.equal((await item()).answers.length, 1);
    });

    test('an answer written against an older view of the question is refused', async () => {
      await rejects(cycle.human.addAnswer(await item(), { body: 'Portrait.', idempotencyKey: 'k-2', previousAnswerId: null }), 409);
      const seen = (await item()).answer.id;
      await cycle.human.addAnswer(await item(), { body: 'Portrait after all.', idempotencyKey: 'k-2', previousAnswerId: seen });
      assert.deepEqual((await item()).answers.map((a) => a.body), ['Square.', 'Portrait after all.'], 'answers only ever grow, newest last');
    });

    test('empty and oversize input is refused, never cut', async () => {
      const asked = await item();
      await rejects(cycle.human.addAnswer(asked, { body: '   ' }), 400);
      await rejects(cycle.human.addAnswer(asked, { body: 'x'.repeat(8001) }), 413);
      await rejects(cycle.human.addAnswer(asked, { body: 'ok', source: 'y'.repeat(201) }), 413);
      await rejects(cycle.human.addAnswer(asked, { body: 'ok', idempotencyKey: 'k'.repeat(81) }), 400);
      assert.equal((await item()).answers.length, 2);
    });

    test('only an answer answers: sent, dropped and reopen are the other moves', async () => {
      const asked = await item();
      await rejects(cycle.human.setResolution(asked, { resolution: 'answered' }), 400);
      await rejects(cycle.human.setResolution(asked, { resolution: 'dropped' }), 400);
      await rejects(cycle.human.setResolution(asked, { resolution: 'dropped', note: 'n'.repeat(2001) }), 413);

      await cycle.human.setResolution(asked, { resolution: 'dropped', note: 'Decided with Mara it does not matter.' });
      const dropped = await item();
      assert.deepEqual([dropped.state, dropped.resolution, dropped.userNote], ['handled', 'dropped', 'Decided with Mara it does not matter.']);

      await cycle.human.setResolution(dropped, { resolution: null });
      const reopened = await item();
      assert.deepEqual([reopened.state, reopened.answer], ['open', null]);
      assert.equal(reopened.answers.length, 2, 'reopening keeps the history');
    });

    test('nothing recorded, nothing to confirm', async () => {
      const untouched = (await cycle.build({ now: NOW })).model.inbox['question:qs101:q-badge-colour'];
      assert.ok(untouched, 'the fixture has a question nobody touched');
      await rejects(cycle.human.confirm(untouched), 400);
    });
  });

  describe(`${name}: ticks on everything that is not a question`, () => {
    const ID = 'verify-close:hb121:fixed';
    let cycle;
    let close;
    before(async () => { ({ cycle, close } = await open(kitchenSink, NOW)); });
    after(() => close());

    test('a tick parks the item, and clearing it brings the item back', async () => {
      const first = await cycle.build({ now: NOW });
      await cycle.human.setResolution(first.model.inbox[ID], { resolution: 'verified' }, first.model.cycle.lastTriage);
      const parked = await cycle.build({ now: NOW });
      assert.equal(parked.model.inbox[ID].state, 'waiting');

      await cycle.human.setResolution(parked.model.inbox[ID], { resolution: null }, first.model.cycle.lastTriage);
      assert.equal((await cycle.build({ now: NOW })).model.inbox[ID].state, 'open');
    });

    test('a tick note is cut at 2000 characters; only answers are refused for length', async () => {
      const { model } = await cycle.build({ now: NOW });
      await cycle.human.setResolution(model.inbox[ID], { resolution: 'verified', note: 'n'.repeat(2500) }, model.cycle.lastTriage);
      assert.equal((await cycle.build({ now: NOW })).model.inbox[ID].userNote.length, 2000);
    });

    test('a tick made on an older wording shows as changed', async () => {
      const { model } = await cycle.build({ now: NOW });
      const stale = Object.values(model.inbox).filter((i) => i.state === 'changed');
      assert.ok(stale.length >= 1, 'the fixture carries a tick with a stale fingerprint');
    });
  });
}
