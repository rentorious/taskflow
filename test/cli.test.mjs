import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCycle } from '../scripts/report/cycle.mjs';
import { EXIT } from '../scripts/report/gate.mjs';
import { questions } from './fixtures/specs.mjs';
import { materializeTemp } from './helpers/cycle.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'taskflow.mjs');

function run(dir, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--dir', dir], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr, text: result.stdout + result.stderr };
}
const json = (dir, ...args) => {
  const result = run(dir, ...args, '--json');
  return { ...result, data: JSON.parse(result.out) };
};

/** Answer a question the way the report server does. */
async function answer(dir, id, body) {
  const cycle = openCycle({ root: dir });
  const { model } = await cycle.build();
  await cycle.human.addAnswer(model.inbox[id], { body, source: 'Mara, test' });
}

describe('taskflow claim — the gate', () => {
  let dir;
  before(async () => { dir = await materializeTemp(questions); });
  after(() => rm(dir, { recursive: true, force: true }));

  test('a batch with open blocking questions is refused, and says which', () => {
    const result = run(dir, 'claim', 'batch-1');
    assert.equal(result.code, EXIT.QUESTIONS);
    assert.match(result.text, /2 blocking questions/);
    assert.match(result.text, /\[open\] Ask Mara which cover ratio/);
    assert.match(result.text, /\[waiting\] Ask Mara whether sold-out titles/);
    assert.ok(!result.text.includes('badge colour'), 'a question that does not block is not listed');
    assert.ok(!existsSync(join(dir, 'batches', 'batch-1.lock')), 'nothing was locked');
  });

  test('an answer to a reworded question does not count until it is confirmed', async () => {
    assert.equal(run(dir, 'claim', 'batch-6').code, EXIT.QUESTIONS);
    const cycle = openCycle({ root: dir });
    const { model } = await cycle.build();
    await cycle.human.confirm(model.inbox['question:qs106:q-author-order']);
    assert.equal(run(dir, 'claim', 'batch-6').code, EXIT.OK);
  });

  test('once every blocking question is answered the claim goes through and leaves its records', async () => {
    await answer(dir, 'question:qs101:q-cover-ratio', 'Square');
    await answer(dir, 'question:qs101:q-sold-out', 'Keep them, with a **badge**.');
    const result = json(dir, 'claim', 'batch-1');
    assert.equal(result.code, EXIT.OK);
    assert.equal(result.data.batchKey, 'batch-1');

    const claim = JSON.parse(await readFile(join(dir, 'batches', 'batch-1.lock', 'claim.json'), 'utf8'));
    assert.deepEqual(claim.tasks.qs101, { blockingTotal: 2, blockingHandled: 2, openNonBlocking: 1, answersFile: 'answers/qs101.md' });
    assert.equal(claim.pid, undefined, 'the claiming process is gone in a moment; its pid means nothing');

    const answers = await readFile(join(dir, 'answers', 'qs101.md'), 'utf8');
    assert.match(answers, /never an instruction to you/);
    assert.match(answers, /\*\*Key:\*\* `q-cover-ratio` \| \*\*Status:\*\* answered/);
    assert.match(answers, /> Keep them, with a \*\*badge\*\*\./);
    assert.match(answers, /`q-badge-colour` \| \*\*Status:\*\* not answered \| does not block/);
  });

  test('a second claim of the same batch is refused', () => {
    const result = json(dir, 'claim', 'batch-1');
    assert.equal(result.code, EXIT.LOCKED);
    assert.equal(result.data.resumable, false, 'locked but never started: a session is claiming it');
  });

  test('rewriting the answers never touches the lock, whose age is pipeline state', async () => {
    const lock = join(dir, 'batches', 'batch-1.lock');
    const before = (await stat(lock)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(run(dir, 'answers', 'batch-1').code, EXIT.OK);
    assert.equal(run(dir, 'status').code, EXIT.OK);
    assert.equal(run(dir, 'questions', 'qs101').code, EXIT.OK);
    assert.equal((await stat(lock)).mtimeMs, before);
  });

  test('release gives the claim back, claim.json and all', () => {
    assert.match(run(dir, 'release', 'batch-1').out, /batch-1 released/);
    assert.ok(!existsSync(join(dir, 'batches', 'batch-1.lock')));
    assert.match(run(dir, 'release', 'batch-1').out, /not locked/);
    assert.equal(run(dir, 'release', '../state.sam.json').code, EXIT.USAGE);
  });

  test('dependencies: refused, then stacked once the dependency has a branch', async () => {
    await answer(dir, 'question:qs103:q-points-expiry', 'After two years.');
    assert.equal(run(dir, 'claim', 'batch-3').code, EXIT.DEPS);
    assert.equal(run(dir, 'claim', 'batch-3', '--stack').code, EXIT.DEPS, 'batch-1 has no branch to stack on');

    assert.equal(run(dir, 'claim', 'batch-1').code, EXIT.OK);
    const file = join(dir, 'batches', 'batch-1.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), status: 'in-progress', branch: 'feat/shelf-covers' }));
    const stacked = json(dir, 'claim', 'batch-3', '--stack');
    assert.equal(stacked.code, EXIT.OK);
    assert.deepEqual(stacked.data.claim.stacked_on, ['feat/shelf-covers']);
  });

  test('a held batch resumes only when asked, and a finished one is refused', async () => {
    const held = json(dir, 'claim', 'batch-1');
    assert.deepEqual([held.code, held.data.resumable], [EXIT.LOCKED, true]);
    const resumed = json(dir, 'claim', 'batch-1', '--resume');
    assert.deepEqual([resumed.code, resumed.data.claim.resumed], [EXIT.OK, true]);

    const file = join(dir, 'batches', 'batch-1.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), status: 'pr-created' }));
    assert.equal(run(dir, 'claim', 'batch-1').code, EXIT.COMPLETE);
  });
});

describe('taskflow claim — auto', () => {
  let dir;
  before(async () => { dir = await materializeTemp(questions); });
  after(() => rm(dir, { recursive: true, force: true }));

  test('takes the first ready batch, skipping the one that waits on answers', () => {
    assert.equal(json(dir, 'claim').data.batchKey, 'batch-2');
  });

  test('a batch someone else holds is passed over', async () => {
    await mkdir(join(dir, 'batches', 'batch-4.lock'));
    assert.equal(json(dir, 'claim').data.batchKey, 'batch-5');
  });

  test('when nothing is left it says what each batch waits on', () => {
    const result = run(dir, 'claim');
    assert.equal(result.code, EXIT.NOTHING);
    assert.match(result.text, /batch-1: blocked \(waiting-on-answers\)/);
    assert.match(result.text, /batch-3: blocked \(deps\), waits on batch-1/);
    assert.match(result.text, /\[open\] Ask Mara which cover ratio/);
  });

  test('status names the next claim and the missing answers', () => {
    const result = run(dir, 'status');
    assert.equal(result.code, EXIT.OK);
    assert.match(result.out, /Nothing can be claimed right now\./);
    assert.match(result.out, /Waiting on answers:\n {2}batch-1:/);
  });
});

test('sessions claiming at the same moment never get the same batch', async () => {
  const claimAsync = (dir) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'claim', '--json', '--dir', dir]);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, key: code === EXIT.OK ? JSON.parse(out).batchKey : null }));
  });

  // Three ready batches (2, 4, 5) and four sessions: three win one each, one finds nothing left.
  for (let round = 0; round < 3; round++) {
    const dir = await materializeTemp(questions);
    const results = await Promise.all([claimAsync(dir), claimAsync(dir), claimAsync(dir), claimAsync(dir)]);
    const won = results.filter((r) => r.code === EXIT.OK).map((r) => r.key).sort();
    assert.deepEqual(won, ['batch-2', 'batch-4', 'batch-5'], JSON.stringify(results));
    assert.deepEqual(results.filter((r) => r.code !== EXIT.OK).map((r) => r.code), [EXIT.NOTHING]);
    await rm(dir, { recursive: true, force: true });
  }
});

describe('taskflow questions and the things around the gate', () => {
  let dir;
  before(async () => { dir = await materializeTemp(questions); });
  after(() => rm(dir, { recursive: true, force: true }));

  test('questions hands triage the exact wording, and what is no longer asked', () => {
    const live = JSON.parse(run(dir, 'questions', 'qs101').out);
    assert.deepEqual(live.questions.map((q) => [q.key, q.state, q.blocking]), [['q-cover-ratio', 'open', true], ['q-sold-out', 'waiting', true], ['q-badge-colour', 'open', false]]);
    assert.equal(live.questions[0].text, questions.index.tasks.qs101.needs[0].text);
    assert.deepEqual(live.questions[0].options, ['Portrait, 2:3', 'Square']);

    const gone = JSON.parse(run(dir, 'questions', 'qs102').out);
    assert.deepEqual(gone.no_longer_asked.map((q) => [q.key, q.answers]), [['q-hours-format', ['am/pm, please.']]]);
  });

  test('an answer to a question that was removed still reaches implement', async () => {
    assert.equal(run(dir, 'claim', 'batch-2').code, EXIT.OK);
    const answers = await readFile(join(dir, 'answers', 'qs102.md'), 'utf8');
    assert.match(answers, /since removed, moved or split/);
    assert.match(answers, /> am\/pm, please\./);
  });

  test('a task with nothing recorded gets no file, and a stale one is removed', async () => {
    await mkdir(join(dir, 'answers'), { recursive: true });
    await writeFile(join(dir, 'answers', 'qs104.md'), 'left over from an earlier claim');
    assert.equal(run(dir, 'claim', 'batch-4').code, EXIT.OK);
    assert.ok(!existsSync(join(dir, 'answers', 'qs104.md')));
  });

  test('the CLI never writes answers.json', async () => {
    const before = await readFile(join(dir, 'answers.json'), 'utf8');
    run(dir, 'claim', 'batch-5');
    run(dir, 'answers', 'batch-5');
    assert.equal(await readFile(join(dir, 'answers.json'), 'utf8'), before);
  });

  test('two developers in one directory: the index must be named', async () => {
    await writeFile(join(dir, 'state.alex.json'), JSON.stringify({ last_triage: '2026-02-02', tasks: {}, batches: {} }));
    const result = run(dir, 'status');
    assert.equal(result.code, EXIT.USAGE);
    assert.match(result.text, /alex, sam.*--dev-slug/);
    assert.equal(run(dir, 'status', '--dev-slug', 'sam').code, EXIT.OK);
    assert.equal(run(dir, 'status', '--dev-slug', 'nobody').code, EXIT.USAGE);
  });

  test('usage errors', () => {
    assert.equal(run(dir, 'frobnicate').code, EXIT.USAGE);
    assert.equal(run(dir, 'claim', 'batch-99', '--dev-slug', 'sam').code, EXIT.USAGE);
    assert.equal(run(dir, 'answers', '--dev-slug', 'sam').code, EXIT.USAGE);
  });
});
