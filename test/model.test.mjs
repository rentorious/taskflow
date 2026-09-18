import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { CLAIMING_WINDOW_MS, buildModel, buildTaskDetail, deriveLane, orderBatchKeys } from '../scripts/report/model.mjs';
import { createReader } from '../scripts/report/read.mjs';
import { createTickStore } from '../scripts/report/ticks.mjs';
import { allPending, archiveShape, kitchenSink } from './fixtures/specs.mjs';
import { materializeTemp } from './helpers/cycle.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

async function load(spec, options = {}) {
  const dir = await materializeTemp(spec, NOW);
  const raw = await createReader(dir, options.reader).read();
  const ticks = await createTickStore(dir, raw.cycle.slug).load();
  return { dir, raw, model: buildModel(raw, { ticks, now: NOW, enrichment: options.enrichment ?? null }) };
}

const lanesOf = (model) => Object.fromEntries(Object.values(model.batches).map((b) => [b.key, b.laneReason ? `${b.lane}/${b.laneReason}` : b.lane]));

describe('deriveLane — first match wins', () => {
  const base = { status: 'pending', locked: false, lockAgeMs: null, fileStale: false, indexTasksAllStale: false, depReason: null, prState: null };
  const lane = (overrides) => {
    const { lane: l, reason } = deriveLane({ ...base, ...overrides });
    return reason ? `${l}/${reason}` : l;
  };

  test('rows 1-4: complete batches, where a lock is normal', () => {
    assert.equal(lane({ status: 'done', locked: true }), 'shipped');
    assert.equal(lane({ status: 'pr-created', prState: 'merged', locked: true }), 'shipped');
    assert.equal(lane({ status: 'pr-created', prState: 'closed' }), 'stale/pr-closed');
    assert.equal(lane({ status: 'pr-created', prState: 'open', locked: true, lockAgeMs: 9e9 }), 'pr-open');
    assert.equal(lane({ status: 'pr-created', prState: 'unknown' }), 'pr-open');
  });

  test('rows 5-7: stale and in-progress', () => {
    assert.equal(lane({ status: 'stale', fileStale: true }), 'stale');
    assert.equal(lane({ status: 'in-progress', fileStale: true, locked: true }), 'stale');
    assert.equal(lane({ status: 'in-progress', locked: true }), 'in-flight');
    assert.equal(lane({ status: 'in-progress', locked: false }), 'in-flight/orphaned');
  });

  test('rows 8-9: a young lock is a session starting up, an old one is stale', () => {
    assert.equal(lane({ locked: true, lockAgeMs: CLAIMING_WINDOW_MS - 1 }), 'in-flight/claiming');
    assert.equal(lane({ locked: true, lockAgeMs: CLAIMING_WINDOW_MS }), 'blocked/stale-lock');
    assert.equal(lane({ locked: true, lockAgeMs: 1000, depReason: 'deps' }), 'in-flight/claiming');
  });

  test('rows 10-13: pending and unlocked', () => {
    assert.equal(lane({ indexTasksAllStale: true }), 'stale/tasks-left-todo');
    assert.equal(lane({}), 'ready');
    assert.equal(lane({ depReason: 'deps' }), 'blocked/deps');
    assert.equal(lane({ depReason: 'dep-cycle' }), 'blocked/dep-cycle');
    assert.equal(lane({ questionsOpen: 2 }), 'blocked/waiting-on-answers');
    assert.equal(lane({ questionsOpen: 2, depReason: 'deps' }), 'blocked/deps', 'answering alone would not free it');
  });

  test('open questions never move a batch that is already past claiming', () => {
    assert.equal(lane({ questionsOpen: 1, status: 'in-progress', locked: true }), 'in-flight');
    assert.equal(lane({ questionsOpen: 1, status: 'pr-created', prState: 'open' }), 'pr-open');
    assert.equal(lane({ questionsOpen: 1, locked: true, lockAgeMs: 1000 }), 'in-flight/claiming');
  });
});

test('claim order is numeric, not lexical', () => {
  assert.deepEqual(orderBatchKeys(['batch-10', 'batch-2', 'hotfix', 'batch-1']), ['batch-1', 'batch-2', 'batch-10', 'hotfix']);
});

describe('kitchen-sink cycle', () => {
  let ctx;
  before(async () => { ctx = await load(kitchenSink); });
  after(() => rm(ctx.dir, { recursive: true, force: true }));

  test('every batch lands in the expected lane', () => {
    assert.deepEqual(lanesOf(ctx.model), {
      'batch-1': 'shipped',
      'batch-2': 'pr-open',
      'batch-3': 'in-flight',
      'batch-4': 'in-flight/claiming',
      'batch-5': 'ready',
      'batch-6': 'blocked/waiting-on-answers',
      'batch-7': 'ready',
      'batch-8': 'blocked/deps',
      'batch-9': 'blocked/stale-lock',
      'batch-10': 'in-flight/orphaned',
      'batch-11': 'stale',
      'batch-12': 'blocked/dep-stale',
      'batch-13': 'blocked/dep-missing',
      'batch-14': 'blocked/dep-cycle',
      'batch-15': 'blocked/dep-cycle',
      'batch-16': 'ready',
      'batch-17': 'ready',
    });
  });

  test('Ready is exactly what implement would auto-claim, in order', () => {
    assert.deepEqual(ctx.model.laneOrder.ready, ['batch-5', 'batch-7', 'batch-16', 'batch-17'], 'batch-6 waits on an answer');
    assert.deepEqual(ctx.model.laneOrder.ready.map((k) => ctx.model.batches[k].claimOrder), [1, 2, 3, 4]);
    assert.equal(ctx.model.batches['batch-6'].claimOrder, null);
  });

  test('blockedBy / unblocks / stacking', () => {
    const { batches } = ctx.model;
    assert.deepEqual(batches['batch-8'].blockedBy, ['batch-5', 'batch-6']);
    assert.deepEqual(batches['batch-5'].unblocks, ['batch-8']);
    assert.deepEqual(batches['batch-7'].blockedBy, []);
    assert.deepEqual(batches['batch-7'].stackOn, { key: 'batch-2', branch: 'feat/restock-badge', prNumber: 102 });
  });

  test('a batch in flight reports progress, and goes quiet only after a long idle', () => {
    assert.deepEqual(ctx.model.batches['batch-3'].progress, { total: 3, planned: 1, inProgress: 1, committed: 1, stale: 0 });
    assert.equal(ctx.model.batches['batch-3'].laneReason, null, 'the batch file changed 4 minutes ago');
    const later = buildModel(ctx.raw, { now: NOW + 2 * 60 * 60 * 1000 });
    assert.equal(later.batches['batch-3'].laneReason, 'quiet');
    assert.equal(later.batches['batch-4'].lane, 'blocked', 'a claiming lock that never progressed turns stale');
  });

  test('edge cases are flagged and reported, never fatal', () => {
    const { batches, health } = ctx.model;
    assert.ok(batches['batch-16'].flags.includes('batch-unreadable'));
    assert.ok(batches['batch-17'].flags.includes('unknown-status'));
    assert.ok(batches['batch-17'].flags.includes('self-dependency'));
    const codes = health.problems.map((p) => `${p.code}:${p.subject}`);
    for (const expected of ['batch-unreadable:batch-16', 'unknown-status:batch-17', 'dep-missing:batch-13', 'dep-cycle:batch-14', 'plan-missing:hb120']) {
      assert.ok(codes.includes(expected), `${expected} missing from ${codes.join(', ')}`);
    }
    assert.equal(health.ok, false);
  });

  test('rollups and estimate ranges', () => {
    const b3 = ctx.model.batches['batch-3'];
    assert.deepEqual(b3.rollup, { size: 'medium', minConfidence: 'medium', topPriority: 'high', areas: ['admin'], types: ['feature'] });
    assert.deepEqual(b3.estimate.agent, { minMinutes: 85, maxMinutes: 115, count: 3, unparsed: 0, caveats: 0 });
    assert.equal(ctx.model.batches['batch-8'].estimate.human.caveats, 1);
    assert.equal(ctx.model.tasks.hb123.estimate.human.parsed, false);
  });

  test('long titles get a short name; triage-written short names win', () => {
    assert.ok(ctx.model.tasks.hb124.shortName.length <= 71);
    assert.ok(ctx.model.tasks.hb124.shortName.endsWith('…'));
    assert.equal(ctx.model.tasks.hb101.shortName, 'Shelf covers load at full size on mobile');
  });

  test('unbatched tasks carry a disposition', () => {
    const { tasks, laneOrder } = ctx.model;
    assert.deepEqual([...laneOrder.unbatched].sort(), ['hb121', 'hb122', 'hb123', 'hb124']);
    assert.equal(laneOrder.unbatched[0], 'hb121');
    assert.deepEqual(['hb121', 'hb122', 'hb123', 'hb124'].map((id) => tasks[id].disposition), ['already-fixed', 'duplicate', 'manual', 'unassigned']);
  });

  test('inbox: origins, states and ranking', () => {
    const { inbox, laneOrder, counts, batches } = ctx.model;
    const state = (id) => inbox[id]?.state;

    assert.equal(state('question:hb108:question'), 'open');
    assert.equal(state('question:hb111:question'), 'waiting', 'already delivered via the description');
    assert.equal(state('owed-write:hb111:dev-notes'), 'open');
    assert.equal(state('verify-close:hb121:fixed'), 'open');
    assert.equal(state('suggestion:cycle:refund-rounding'), 'changed', 'ticked, then reworded');
    assert.equal(inbox['question:hb112:question'].origin, 'plan-fallback');
    assert.equal(inbox['question:hb110:question'], undefined, 'explicit empty needs[] suppresses the fallback');

    for (const id of ['stale-lock:batch-9:lock', 'orphaned-claim:batch-10:claim', 'dep-problem:batch-12:dep-stale', 'dep-problem:batch-13:dep-missing', 'dep-problem:batch-14:dep-cycle']) {
      assert.equal(inbox[id]?.tickable, false, id);
    }
    assert.equal(inbox['stale-lock:batch-9:lock'].command, '/taskflow:implement --unlock batch-9');
    assert.equal(inbox['stale-lock:batch-2:lock'], undefined, 'a lock on a finished batch is normal');

    assert.equal(laneOrder['needs-you'][0], 'stale-lock:batch-9:lock', 'broken pipeline state ranks first');
    assert.equal(counts.waitingOnClient, 1);
    assert.equal(counts.needsYou, laneOrder['needs-you'].length - 1);

    assert.equal(batches['batch-6'].blockingQuestions, 1);
    assert.deepEqual(batches['batch-6'].blockingItemIds, ['question:hb108:question']);
    assert.equal(batches['batch-6'].lane, 'blocked', 'an open blocking question keeps the batch out of Ready');
    assert.ok(batches['batch-6'].hasLowConfidence);
    assert.equal(batches['batch-8'].blockingQuestions, 1, 'a sent question is not an answer');
    assert.equal(batches['batch-8'].laneReason, 'deps', 'the dependency outranks the question');
    assert.equal(batches['batch-9'].blockingQuestions, 0, 'a fallback question on a confident task does not block');
  });

  test('task detail renders plan sections safely', () => {
    const detail = buildTaskDetail(ctx.raw, 'hb101');
    assert.ok(detail.sections.some((s) => s.slug === 'hostile-content'));
    const all = detail.sections.map((s) => s.html).join('');
    assert.ok(!/<script|<img|onerror=|href="javascript/i.test(all.replace(/&lt;[^&]*&gt;/g, '')), 'no live markup from the plan');
    assert.deepEqual(detail.attachments.map((a) => a.name), ['after.png', 'before.png', 'diagram.svg'], 'unknown file types are dropped');
    assert.equal(detail.attachments[0].url, 'attachments/hb101/after.png');
  });

  test('state is never read from the plan header', () => {
    assert.equal(ctx.model.tasks.hb101.batch, 'batch-1', 'the header says batch-99');
  });

  test('the version ignores the clock but not the content', () => {
    const later = buildModel(ctx.raw, { ticks: { items: {} }, now: NOW + 1000 });
    const same = buildModel(ctx.raw, { ticks: { items: {} }, now: NOW + 2000 });
    assert.equal(later.version, same.version);
    assert.notEqual(later.version, ctx.model.version, 'ticks differ');
  });

  test('enrichment: a merged pull request ships the batch and flags its worktree', () => {
    const prUrl = ctx.model.batches['batch-2'].pr.url;
    const model = buildModel(ctx.raw, {
      now: NOW,
      enrichment: { git: 'ok', gh: 'ok', prs: { [prUrl]: { state: 'merged', checks: 'passing' } }, worktrees: [{ path: '/tmp/harbor-feat-restock-badge', branch: 'feat/restock-badge' }] },
    });
    assert.equal(model.batches['batch-2'].lane, 'shipped');
    assert.equal(model.batches['batch-7'].stackOn, null, 'nothing to stack on once it merged');
    assert.equal(model.inbox['leftover-worktree:batch-2:worktree'].command, 'git worktree remove "/tmp/harbor-feat-restock-badge"');
  });

  test('enrichment: a closed pull request raises one item, not a bogus stale-lock too', () => {
    const prUrl = ctx.model.batches['batch-2'].pr.url;
    const model = buildModel(ctx.raw, { now: NOW, enrichment: { prs: { [prUrl]: { state: 'closed', checks: 'failing' } } } });
    assert.equal(model.batches['batch-2'].lane, 'stale');
    assert.ok(model.inbox['pr-closed:batch-2:pr']);
    assert.equal(model.inbox['stale-lock:batch-2:lock'], undefined);
  });

  test('enrichment: failing checks raise an item', () => {
    const prUrl = ctx.model.batches['batch-2'].pr.url;
    const model = buildModel(ctx.raw, { now: NOW, enrichment: { prs: { [prUrl]: { state: 'open', checks: 'failing', reviewDecision: 'CHANGES_REQUESTED' } } } });
    assert.match(model.inbox['pr-attention:batch-2:pr'].title, /#102 needs work/);
  });
});

describe('all-pending cycle (schema v1, straight after triage)', () => {
  let ctx;
  before(async () => { ctx = await load(allPending); });
  after(() => rm(ctx.dir, { recursive: true, force: true }));

  test('ready and blocked match what implement would do', () => {
    const { laneOrder, batches, counts } = ctx.model;
    assert.deepEqual(laneOrder.ready, Array.from({ length: 9 }, (_, i) => `batch-${i + 1}`));
    assert.deepEqual(laneOrder.blocked, ['batch-10', 'batch-11', 'batch-12']);
    assert.equal(batches['batch-10'].laneReason, 'waiting-on-answers', 'a prose question on a low-confidence task gates too');
    assert.deepEqual(batches['batch-11'].blockedBy, ['batch-1', 'batch-2', 'batch-5']);
    assert.deepEqual(batches['batch-3'].unblocks, ['batch-12']);
    assert.equal(counts.inFlight + counts.prOpen + counts.shipped + counts.stale, 0);
    assert.equal(ctx.model.cycle.schemaVersion, 1);
  });

  test('the inbox still fills from plan files and already_fixed', () => {
    assert.deepEqual(Object.keys(ctx.model.inbox).sort(), ['question:ap110:question', 'verify-close:ap200:fixed']);
    assert.equal(ctx.model.inbox['question:ap110:question'].blocking, true, 'low confidence halts implement');
  });
});

describe('archive-shape cycle', () => {
  let ctx;
  before(async () => { ctx = await load(archiveShape); });
  after(() => rm(ctx.dir, { recursive: true, force: true }));

  test('finds a hand-renamed index and an off-date summary', () => {
    assert.equal(ctx.model.cycle.indexFile, 'state.sam.2025-11-20-plus-draft.json');
    assert.equal(ctx.model.cycle.slug, 'sam');
    assert.equal(ctx.model.cycle.summaryFile, 'triage-sam-2025-11-20.md');
  });

  test('old locks on finished batches raise nothing', () => {
    assert.deepEqual(lanesOf(ctx.model), {
      'batch-1': 'pr-open', 'batch-2': 'pr-open', 'batch-3': 'pr-open', 'batch-4': 'ready', 'batch-5': 'ready', 'batch-6': 'blocked/deps',
    });
    assert.deepEqual(Object.keys(ctx.model.inbox), []);
    assert.ok(ctx.model.batches['batch-5'].flags.includes('no-batch-file'));
    assert.equal(ctx.model.tasks.ar101.providerStatus, 'ready to test');
  });
});

test('an empty directory is an empty cycle, not an error', async () => {
  const ctx = await load({ slug: 'sam' });
  assert.equal(ctx.model.cycle.empty, true);
  assert.equal(ctx.model.counts.batches, 0);
  await rm(ctx.dir, { recursive: true, force: true });
});
