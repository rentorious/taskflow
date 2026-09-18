import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EXIT, blocksClaim, evaluateClaim } from '../scripts/report/gate.mjs';
import { CLAIMING_WINDOW_MS, buildModel } from '../scripts/report/model.mjs';
import { MIN, batchFile, question, rawCycle, task } from './helpers/raw.mjs';

const NOW = Date.UTC(2026, 1, 2, 12, 0, 0);
const model = (spec, ticks = { items: {} }) => buildModel(rawCycle(spec), { ticks, now: NOW });
const tick = (resolution, fingerprint) => ({ resolution, fingerprint, at: '2026-02-01T00:00:00.000Z', note: '' });

describe('blocksClaim', () => {
  const item = (over) => ({ kind: 'question', blocking: true, state: 'open', ...over });

  test('only a handled question lets a batch through', () => {
    for (const state of ['open', 'waiting', 'changed']) assert.equal(blocksClaim(item({ state })), true, state);
    assert.equal(blocksClaim(item({ state: 'handled' })), false);
  });

  test('non-blocking questions and other kinds never hold a batch', () => {
    assert.equal(blocksClaim(item({ blocking: false })), false);
    assert.equal(blocksClaim(item({ kind: 'owed-write' })), false);
    assert.equal(blocksClaim(item({ kind: 'verify-close' })), false);
  });
});

describe('evaluateClaim — auto-claim', () => {
  const spec = {
    tasks: {
      a1: task('a1', { batch: 'batch-1', needs: [question('q-colour')] }),
      a2: task('a2', { batch: 'batch-2', needs: [] }),
      a3: task('a3', { batch: 'batch-10', needs: [] }),
    },
    batches: { 'batch-1': { tasks: ['a1'] }, 'batch-2': { tasks: ['a2'] }, 'batch-10': { tasks: ['a3'] } },
  };

  test('walks Ready in claim order and skips a batch that waits on answers', () => {
    const result = evaluateClaim(model(spec));
    assert.equal(result.exit, EXIT.OK);
    assert.deepEqual(result.candidates, ['batch-2', 'batch-10'], 'every ready batch, so the caller can walk past a lost lock race');
  });

  test('once the question is answered its batch is first in line again', () => {
    const open = model(spec);
    const fp = open.inbox['question:a1:q-colour'].fingerprint;
    const result = evaluateClaim(model(spec, { items: { 'question:a1:q-colour': tick('answered', fp) } }));
    assert.deepEqual(result.candidates, ['batch-1', 'batch-2', 'batch-10']);
  });

  test('nothing claimable says why, with the questions to answer', () => {
    const result = evaluateClaim(model({ tasks: { a1: spec.tasks.a1 }, batches: { 'batch-1': { tasks: ['a1'] } } }));
    assert.equal(result.exit, EXIT.NOTHING);
    assert.deepEqual(result.waiting.map((w) => [w.key, w.reason, w.questions.map((q) => q.id)]), [['batch-1', 'waiting-on-answers', ['question:a1:q-colour']]]);
  });
});

describe('evaluateClaim — a named batch', () => {
  const tasks = {
    q1: task('q1', { batch: 'batch-1', needs: [question('q-one'), question('q-soft', { blocking: false })] }),
    d1: task('d1', { batch: 'batch-2', needs: [] }),
    d2: task('d2', { batch: 'batch-3', needs: [question('q-two')] }),
    p1: task('p1', { batch: 'batch-4', needs: [] }),
  };
  const batches = {
    'batch-1': { tasks: ['q1'] },
    'batch-2': { tasks: ['d1'], depends_on: ['batch-4'] },
    'batch-3': { tasks: ['d2'], depends_on: ['batch-4'] },
    'batch-4': { tasks: ['p1'] },
  };

  test('unknown batch is a usage error', () => {
    assert.equal(evaluateClaim(model({ tasks, batches }), { batchKey: 'batch-99' }).exit, EXIT.USAGE);
  });

  test('blocking questions stop it; non-blocking ones do not count', () => {
    const result = evaluateClaim(model({ tasks, batches }), { batchKey: 'batch-1' });
    assert.equal(result.exit, EXIT.QUESTIONS);
    assert.deepEqual(result.questions.map((q) => [q.id, q.state, q.to]), [['question:q1:q-one', 'open', 'Mara']]);
  });

  test('a sent question is still not an answer', () => {
    const fp = model({ tasks, batches }).inbox['question:q1:q-one'].fingerprint;
    const result = evaluateClaim(model({ tasks, batches }, { items: { 'question:q1:q-one': tick('sent', fp) } }), { batchKey: 'batch-1' });
    assert.equal(result.exit, EXIT.QUESTIONS);
    assert.equal(result.questions[0].state, 'waiting');
  });

  test('an answer to a question that was reworded since does not count', () => {
    const result = evaluateClaim(model({ tasks, batches }, { items: { 'question:q1:q-one': tick('answered', 'an-older-text') } }), { batchKey: 'batch-1' });
    assert.equal(result.exit, EXIT.QUESTIONS);
    assert.equal(result.questions[0].state, 'changed');
  });

  test('a dropped question lets it through', () => {
    const fp = model({ tasks, batches }).inbox['question:q1:q-one'].fingerprint;
    assert.equal(evaluateClaim(model({ tasks, batches }, { items: { 'question:q1:q-one': tick('dropped', fp) } }), { batchKey: 'batch-1' }).exit, EXIT.OK);
  });

  test('an unfinished dependency needs --stack, and --stack needs a branch to stack on', () => {
    assert.equal(evaluateClaim(model({ tasks, batches }), { batchKey: 'batch-2' }).exit, EXIT.DEPS);
    const noBranch = evaluateClaim(model({ tasks, batches }), { batchKey: 'batch-2', stack: true });
    assert.equal(noBranch.exit, EXIT.DEPS, 'batch-4 has no branch yet');
    const files = { 'batch-4': batchFile('in-progress', ['p1'], { branch: 'feat/batch-4' }) };
    const stacked = evaluateClaim(model({ tasks, batches, files, locks: { 'batch-4': NOW - MIN } }), { batchKey: 'batch-2', stack: true });
    assert.equal(stacked.exit, EXIT.OK);
    assert.deepEqual(stacked.deps.map((d) => d.branch), ['feat/batch-4']);
  });

  test('questions are reported before dependencies, and --stack never waives them', () => {
    const files = { 'batch-4': batchFile('in-progress', ['p1'], { branch: 'feat/batch-4' }) };
    const built = model({ tasks, batches, files, locks: { 'batch-4': NOW - MIN } });
    assert.equal(built.batches['batch-3'].laneReason, 'deps');
    assert.equal(evaluateClaim(built, { batchKey: 'batch-3' }).exit, EXIT.QUESTIONS);
    assert.equal(evaluateClaim(built, { batchKey: 'batch-3', stack: true }).exit, EXIT.QUESTIONS);
  });

  test('complete and stale batches are refused', () => {
    const done = model({ tasks, batches, files: { 'batch-4': batchFile('pr-created', ['p1'], { branch: 'feat/batch-4' }) } });
    assert.equal(evaluateClaim(done, { batchKey: 'batch-4' }).exit, EXIT.COMPLETE);
    const stale = model({ tasks, batches, files: { 'batch-4': batchFile('stale', ['p1'], { taskStatus: 'stale' }) } });
    assert.equal(evaluateClaim(stale, { batchKey: 'batch-4' }).exit, EXIT.COMPLETE);
  });

  test('a held batch is locked until --resume, and resume re-checks the questions', () => {
    const files = { 'batch-1': batchFile('in-progress', ['q1'], { branch: 'feat/batch-1' }) };
    const held = model({ tasks, batches, files, locks: { 'batch-1': NOW - MIN } });
    const refused = evaluateClaim(held, { batchKey: 'batch-1' });
    assert.deepEqual([refused.exit, refused.resumable], [EXIT.LOCKED, true]);
    assert.equal(evaluateClaim(held, { batchKey: 'batch-1', resume: true }).exit, EXIT.QUESTIONS);

    const fp = held.inbox['question:q1:q-one'].fingerprint;
    const answered = model({ tasks, batches, files, locks: { 'batch-1': NOW - MIN } }, { items: { 'question:q1:q-one': tick('answered', fp) } });
    const resumed = evaluateClaim(answered, { batchKey: 'batch-1', resume: true });
    assert.deepEqual([resumed.exit, resumed.resume, resumed.relock], [EXIT.OK, true, false]);
  });

  test('in progress with no lock is resumed and re-locked without asking', () => {
    const files = { 'batch-4': batchFile('in-progress', ['p1'], { branch: 'feat/batch-4' }) };
    const result = evaluateClaim(model({ tasks, batches, files }), { batchKey: 'batch-4' });
    assert.deepEqual([result.exit, result.resume, result.relock], [EXIT.OK, true, true]);
  });

  test('a lock on a batch that never started: claiming now, or stale', () => {
    const young = evaluateClaim(model({ tasks, batches, locks: { 'batch-4': NOW - MIN } }), { batchKey: 'batch-4' });
    assert.deepEqual([young.exit, young.staleLock, young.resumable], [EXIT.LOCKED, false, false]);
    const old = evaluateClaim(model({ tasks, batches, locks: { 'batch-4': NOW - CLAIMING_WINDOW_MS - MIN } }), { batchKey: 'batch-4' });
    assert.deepEqual([old.exit, old.staleLock], [EXIT.LOCKED, true]);
  });
});

describe('what counts as an open question', () => {
  test('a task that left "to do" holds nothing up', () => {
    const tasks = {
      s1: task('s1', { batch: 'batch-1', needs: [question('q-gone')], stale: true }),
      s2: task('s2', { batch: 'batch-1', needs: [] }),
      s3: task('s3', { batch: 'batch-2', needs: [question('q-skipped')] }),
      s4: task('s4', { batch: 'batch-2', needs: [] }),
    };
    const files = { 'batch-2': { ...batchFile('pending', ['s3', 's4']) } };
    files['batch-2'].data.tasks.s3.status = 'stale';
    const built = model({ tasks, batches: { 'batch-1': { tasks: ['s1', 's2'] }, 'batch-2': { tasks: ['s3', 's4'] } }, files });
    assert.deepEqual(built.laneOrder.ready, ['batch-1', 'batch-2']);
    assert.equal(built.batches['batch-1'].openQuestions, 1, 'still listed, just not blocking');
  });

  test('a need with a broken or repeated key stays, stays blocking, and is reported', () => {
    const tasks = {
      k1: task('k1', { batch: 'batch-1', needs: [{ kind: 'question', key: 'Not A Key!', title: 'Ask about the footer', text: 'Which footer?', blocking: true }] }),
      k2: task('k2', { batch: 'batch-2', needs: [question('q-same'), question('q-same', { title: 'A second question under the same key', text: 'And this one?' })] }),
    };
    const built = model({ tasks, batches: { 'batch-1': { tasks: ['k1'] }, 'batch-2': { tasks: ['k2'] } } });
    assert.deepEqual(built.laneOrder.ready, []);
    assert.equal(built.batches['batch-1'].blockingQuestions, 1);
    assert.match(built.batches['batch-1'].blockingItemIds[0], /^question:k1:q-[0-9a-f]{12}$/);
    assert.equal(built.batches['batch-2'].blockingQuestions, 2);
    assert.deepEqual(built.health.problems.filter((p) => p.code === 'need-key').map((p) => p.subject), ['k1', 'k2']);
  });

  test('a need written twice, word for word, is one item', () => {
    const twice = { kind: 'question', title: 'Ask about the header', text: 'Which header?', blocking: true };
    const built = model({ tasks: { t1: task('t1', { batch: 'batch-1', needs: [twice, twice] }) }, batches: { 'batch-1': { tasks: ['t1'] } } });
    assert.equal(built.batches['batch-1'].blockingQuestions, 1);
  });

  test('options are part of the question, but only when there are any', () => {
    const plain = model({ tasks: { o1: task('o1', { batch: 'batch-1', needs: [question('q-pick')] }) }, batches: { 'batch-1': { tasks: ['o1'] } } });
    const empty = model({ tasks: { o1: task('o1', { batch: 'batch-1', needs: [question('q-pick', { options: [] })] }) }, batches: { 'batch-1': { tasks: ['o1'] } } });
    const picked = model({ tasks: { o1: task('o1', { batch: 'batch-1', needs: [question('q-pick', { options: ['Square', ' Portrait ', 7] })] }) }, batches: { 'batch-1': { tasks: ['o1'] } } });
    const id = 'question:o1:q-pick';
    assert.equal(plain.inbox[id].fingerprint, empty.inbox[id].fingerprint, 'fingerprints from before options existed stay valid');
    assert.notEqual(plain.inbox[id].fingerprint, picked.inbox[id].fingerprint);
    assert.deepEqual(picked.inbox[id].options, ['Square', 'Portrait']);
    assert.equal(plain.inbox[id].options, null);
  });

  test('a task that points at a batch the index does not have keeps no dead batch on its items', () => {
    const built = model({ tasks: { m1: task('m1', { batch: 'batch-7', needs: [question('q-lost')] }) }, batches: {} });
    assert.equal(built.inbox['question:m1:q-lost'].subject.batch, null);
    assert.ok(built.health.problems.some((p) => p.code === 'batch-missing'));
  });
});
