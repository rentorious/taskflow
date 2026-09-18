import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createAnswerStore } from '../scripts/report/answers.mjs';
import { openCycle } from '../scripts/report/cycle.mjs';
import { kitchenSink, questions } from './fixtures/specs.mjs';
import { materializeTemp } from './helpers/cycle.mjs';

const NOW = Date.UTC(2026, 1, 4, 12, 0, 0);
const Q = { taskId: 't1', key: 'q-one', fingerprint: 'fp-1', title: 'Ask about one', text: 'What about one?' };
const ID = 'question:t1:q-one';
const rejects = (promise, status) => assert.rejects(promise, (error) => error.status === status);

describe('answer store', () => {
  let dir;
  let store;
  before(async () => {
    dir = await materializeTemp({ slug: 'sam' });
    store = createAnswerStore(join(dir, 'answers.json'), { archiveRoot: join(dir, 'archive') });
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('a missing file is an empty store, not an error', async () => {
    const { data, problems } = await store.load();
    assert.deepEqual([data.items, problems], [{}, []]);
  });

  test('saving an answer settles the question and snapshots what was asked', async () => {
    const entry = await store.addAnswer(ID, Q, { body: '  Blue.  ', source: 'Mara, by phone', idempotencyKey: 'k-1', previousAnswerId: null });
    assert.equal(entry.resolution, 'answered');
    assert.equal(entry.fingerprint, 'fp-1');
    assert.deepEqual([entry.taskId, entry.key], ['t1', 'q-one']);
    const [answer] = entry.answers;
    assert.deepEqual([answer.body, answer.source, answer.via, answer.questionText], ['Blue.', 'Mara, by phone', 'web', 'What about one?']);
    assert.match(answer.id, /^[0-9a-f]{12}$/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'answers.json'), 'utf8')).items[ID].answers.length, 1);
  });

  test('a retried save adds nothing', async () => {
    const entry = await store.addAnswer(ID, Q, { body: 'Blue.', idempotencyKey: 'k-1' });
    assert.equal(entry.answers.length, 1);
  });

  test('an answer written against an older view of the question is refused', async () => {
    await rejects(store.addAnswer(ID, Q, { body: 'Green.', idempotencyKey: 'k-2', previousAnswerId: null }), 409);
    const seen = (await store.load()).data.items[ID].answers.at(-1).id;
    const entry = await store.addAnswer(ID, Q, { body: 'Green after all.', idempotencyKey: 'k-2', previousAnswerId: seen });
    assert.deepEqual(entry.answers.map((a) => a.body), ['Blue.', 'Green after all.'], 'answers only ever grow');
  });

  test('empty and oversize input is refused, never cut', async () => {
    await rejects(store.addAnswer(ID, Q, { body: '   ' }), 400);
    await rejects(store.addAnswer(ID, Q, { body: 'x'.repeat(8001) }), 413);
    await rejects(store.addAnswer(ID, Q, { body: 'ok', source: 'y'.repeat(201) }), 413);
    assert.equal((await store.load()).data.items[ID].answers.length, 2);
  });

  test('only an answer answers: sent, dropped and reopen are the other moves', async () => {
    await rejects(store.setResolution(ID, Q, { resolution: 'answered' }), 400);
    await rejects(store.setResolution(ID, Q, { resolution: 'dropped' }), 400);
    const dropped = await store.setResolution(ID, Q, { resolution: 'dropped', note: 'Decided with Mara it does not matter.' });
    assert.deepEqual([dropped.resolution, dropped.note], ['dropped', 'Decided with Mara it does not matter.']);
    const reopened = await store.setResolution(ID, Q, { resolution: null });
    assert.equal(reopened.resolution, null);
    assert.equal(reopened.answers.length, 2, 'reopening keeps the history');
  });

  test('confirm moves the state to the new wording and leaves the answer on the old one', async () => {
    await store.addAnswer(ID, Q, { body: 'Blue, final.' });
    const reworded = { ...Q, fingerprint: 'fp-2', title: 'Ask which colour', text: 'Which colour exactly?' };
    const entry = await store.confirm(ID, reworded);
    assert.deepEqual([entry.resolution, entry.fingerprint, entry.title], ['answered', 'fp-2', 'Ask which colour']);
    assert.equal(entry.answers.at(-1).questionFingerprint, 'fp-1');
    await rejects(store.confirm('question:t1:q-never', reworded), 400);
  });

  test('a damaged file is set aside and reported, never overwritten silently', async () => {
    await writeFile(join(dir, 'answers.json'), '{ "items": ');
    const { data, problems } = await store.load();
    assert.deepEqual(data.items, {});
    assert.deepEqual(problems.map((p) => p.code), ['answers-corrupt']);
    assert.ok((await readdir(dir)).some((name) => name.startsWith('answers.json.corrupt-')));
    assert.deepEqual((await store.load()).problems.map((p) => p.code), ['answers-corrupt'], 'still reported until the evidence is removed');
  });

  test('a read-only store never writes', async () => {
    const readOnly = createAnswerStore(join(dir, 'answers.json'), { readOnly: true });
    await rejects(readOnly.addAnswer(ID, Q, { body: 'nope' }), 403);
    await rejects(readOnly.setResolution(ID, Q, { resolution: 'sent' }), 403);
  });
});

test('answers swept into an archive are copied back and reported', async () => {
  const dir = await materializeTemp({ slug: 'sam' });
  await mkdir(join(dir, 'archive', '2026-01-10'), { recursive: true });
  await mkdir(join(dir, 'archive', '2026-02-01'), { recursive: true });
  await writeFile(join(dir, 'archive', '2026-01-10', 'answers.json'), JSON.stringify({ items: { old: { resolution: 'sent', answers: [] } } }));
  await writeFile(join(dir, 'archive', '2026-02-01', 'answers.json'), JSON.stringify({ items: { [ID]: { resolution: 'sent', answers: [] } } }));

  const store = createAnswerStore(join(dir, 'answers.json'), { archiveRoot: join(dir, 'archive') });
  const { data, problems } = await store.load();
  assert.deepEqual(Object.keys(data.items), [ID], 'the newest archive wins');
  assert.deepEqual(problems.map((p) => p.code), ['answers-restored']);

  await store.setResolution(ID, Q, { resolution: 'sent' });
  assert.deepEqual((await store.load()).problems, [], 'cleared by the next write');
  await rm(dir, { recursive: true, force: true });
});

// What any HumanStore must do is in test/contracts/human-store.mjs, run on files by
// test/human-contract.test.mjs. What follows is about the two files behind this one.

test('other kinds still tick into the per-cycle file, never into answers.json', async () => {
  const dirKs = await materializeTemp(kitchenSink, NOW);
  const ks = openCycle({ root: dirKs });
  const first = await ks.build({ now: NOW });
  await ks.human.setResolution(first.model.inbox['verify-close:hb121:fixed'], { resolution: 'verified' }, first.model.cycle.lastTriage);
  const tickFile = JSON.parse(await readFile(join(dirKs, 'report-inbox.sam.json'), 'utf8'));
  assert.equal(tickFile.items['verify-close:hb121:fixed'].resolution, 'verified');
  assert.deepEqual((await readdir(dirKs)).filter((name) => name.startsWith('answers.json')), []);
  await rm(dirKs, { recursive: true, force: true });
});

test('questions are recorded in answers.json, never in the per-cycle file', async () => {
  const dir = await materializeTemp(questions, NOW);
  const cycle = openCycle({ root: dir });
  const { model } = await cycle.build({ now: NOW });
  await cycle.human.setResolution(model.inbox['question:qs101:q-cover-ratio'], { resolution: 'sent' });
  assert.equal(JSON.parse(await readFile(join(dir, 'answers.json'), 'utf8')).items['question:qs101:q-cover-ratio'].resolution, 'sent');
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('report-inbox.')), []);
  await rm(dir, { recursive: true, force: true });
});

describe('question ticks from before answers existed', () => {
  const legacy = (isLive) => ({
    ...kitchenSink,
    ticks: { ...kitchenSink.ticks, items: { 'question:hb108:question': { resolution: 'answered', at: '2026-01-14T10:00:00.000Z', fingerprint: null, title: 'x', note: '' } } },
    ...(isLive ? {} : {}),
  });

  test('a bare "answered" tick never opens a live gate', async () => {
    const dir = await materializeTemp(legacy(true), NOW);
    const { model } = await openCycle({ root: dir }).build({ now: NOW });
    assert.equal(model.inbox['question:hb108:question'].state, 'open');
    assert.equal(model.batches['batch-6'].laneReason, 'waiting-on-answers');
    await rm(dir, { recursive: true, force: true });
  });

  test('in an archive it still describes what happened', async () => {
    const dir = await materializeTemp({ slug: 'sam', archives: { '2026-01-14': legacy(false) } }, NOW);
    const { model } = await openCycle({ root: dir, dir: join(dir, 'archive', '2026-01-14'), cycleId: '2026-01-14', isArchive: true }).build({ now: NOW });
    assert.equal(model.inbox['question:hb108:question'].state, 'handled');
    await rm(dir, { recursive: true, force: true });
  });
});
