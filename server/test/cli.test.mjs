// The whole loop, with the real CLI as a child process against a hosted app:
// push, be refused for open questions, answer them in a "browser", claim, and
// be told no when someone else holds the batch or the server cannot be asked.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { specs } from '../../test/fixtures/specs.mjs';
import { materialize } from '../../test/helpers/cycle.mjs';
import { profile, startHosted } from './helpers/hosted.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'taskflow.mjs');
const NOW = Date.UTC(2026, 1, 4, 12, 0, 0);

/** Async on purpose: the server under test lives in this process, and spawnSync would stop it answering. */
function run(args, { cwd, home, stdin = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, XDG_CONFIG_HOME: home, TASKFLOW_TOKEN: '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, text: stdout + stderr }));
    child.stdin.end(stdin);
  });
}

describe('a hosted project, from the laptop', () => {
  let h; let ann; let root; let out; let home; let token;
  const cli = (args, extra = {}) => run(args, { cwd: root, home, ...extra });
  const model = async () => (await ann.get('/p/harbor/u/ann/api/model')).json();
  const answer = async (id, body) => {
    const item = (await model()).inbox[id];
    const res = await ann.post('/p/harbor/u/ann/api/answer', { json: { id, fingerprint: item.fingerprint, body, source: 'Mara, from her phone' } });
    assert.equal(res.status, 200);
  };

  before(async () => {
    h = await startHosted({ admins: ['ann'] });
    ann = h.browser(); await ann.signIn(profile('ann'));
    await ann.post('/settings/projects', { form: { id: 'harbor', name: 'Harbor Books' } });
    token = /tfp_[A-Za-z0-9_-]+/.exec(await (await ann.post('/settings/tokens', { form: { label: 'laptop' } })).text())[0];

    root = await mkdtemp(join(tmpdir(), 'taskflow-hosted-'));
    home = join(root, '.xdg');
    out = join(root, 'out');
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'taskflow-config.json'), JSON.stringify({ project_name: 'Harbor Books', output_dir: 'out', base_branch: 'dev', server: { url: h.origin, project: 'harbor' } }));
    await materialize(specs.questions, out, NOW);
  });
  after(async () => { await h.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });

  test('without a token nothing can be asked: exit 4, and it says what to do', async () => {
    const res = await cli(['claim', 'batch-2']);
    assert.equal(res.code, 4);
    assert.match(res.text, /No token for .*login/);
    assert.ok(!existsSync(join(out, 'batches', 'batch-2.lock')));
  });

  test('login takes the token from stdin, checks it, and keeps it where only this user can read it', async () => {
    assert.equal((await cli(['login', h.origin], { stdin: 'tfp_not-a-real-token\n' })).code, 4);
    const res = await cli(['login', h.origin], { stdin: `${token}\n` });
    assert.equal(res.code, 0, res.text);
    assert.match(res.stdout, /as ann.*\n?.*harbor/s);
    const path = join(home, 'taskflow', 'credentials.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, 'utf8'))[h.origin].token, token);
    assert.equal((await cli(['login', 'http://flow.example.com'], { stdin: `${token}\n` })).code, 1, 'never over plain http to another machine');
  });

  test('push mirrors the cycle; --import-answers moves what was recorded locally, once, and the file steps aside', async () => {
    const first = await cli(['push', '--import-answers']);
    assert.equal(first.code, 0, first.text);
    assert.match(first.stdout, /Pushed: .*\/p\/harbor\//);
    assert.match(first.stdout, /Imported 4 questions with 3 answers; 0 skipped/);
    assert.ok(!existsSync(join(out, 'answers.json')));
    assert.ok((await readdir(out)).some((name) => name.startsWith('answers.json.imported-')));
    assert.ok(existsSync(join(out, 'cycle.sam.json')), 'the cycle has an id now');

    assert.match((await cli(['push'])).stdout, /Unchanged/);
    const m = await model();
    assert.deepEqual([m.cycle.hosted, m.batches['batch-5'].lane, m.inbox['question:qs105:q-slip-logo'].state], [true, 'ready', 'handled']);
  });

  test('open blocking questions: exit 2, each one named, with the address where they are answered', async () => {
    const res = await cli(['claim', 'batch-1']);
    assert.equal(res.code, 2, res.text);
    assert.match(res.stderr, /2 blocking questions/);
    assert.match(res.stderr, /cover ratio/);
    assert.ok(res.stderr.includes(`${h.origin}/p/harbor/`));
    assert.ok(!existsSync(join(out, 'batches', 'batch-1.lock')));
  });

  test('answered in a browser, the claim goes through on the laptop and the answers arrive next to the plan', async () => {
    await answer('question:qs101:q-cover-ratio', 'Square.');
    await answer('question:qs101:q-sold-out', 'Keep them, with a badge.');

    const res = await cli(['claim', 'batch-1']);
    assert.equal(res.code, 0, res.text);
    assert.match(res.stdout, /Claimed batch-1/);
    const answers = await readFile(join(out, 'answers', 'qs101.md'), 'utf8');
    assert.match(answers, /> Square\./);
    assert.match(answers, /Mara, from her phone/);
    assert.ok(answers.includes(h.origin), 'it says where the answers came from');
    const claim = JSON.parse(await readFile(join(out, 'batches', 'batch-1.lock', 'claim.json'), 'utf8'));
    assert.deepEqual([claim.batch, claim.tasks.qs101.blockingTotal, claim.tasks.qs101.blockingHandled], ['batch-1', 2, 2]);

    const batch = (await model()).batches['batch-1'];
    assert.deepEqual([batch.lane, batch.laneReason, batch.locked], ['in-flight', 'claiming', true], 'the page shows the claim at once');
  });

  test('a second claim of the same batch: exit 3. Released, it can be claimed again', async () => {
    assert.equal((await cli(['claim', 'batch-1'])).code, 3);
    const released = await cli(['release', 'batch-1']);
    assert.equal(released.code, 0, released.text);
    assert.ok(!existsSync(join(out, 'batches', 'batch-1.lock')));
    assert.equal((await model()).batches['batch-1'].lane, 'ready');
    assert.equal((await cli(['claim', 'batch-1'])).code, 0);
  });

  test('with no batch named it takes the first ready one and walks past what is held or waiting', async () => {
    const res = await cli(['claim', '--json']);
    assert.equal(res.code, 0, res.text);
    assert.equal(JSON.parse(res.stdout).batchKey, 'batch-2');
  });

  test('status and questions read the server too', async () => {
    const status = await cli(['status']);
    assert.equal(status.code, 0, status.text);
    assert.match(status.stdout, /Next to claim: batch-4/);
    assert.match(status.stdout, /batch-6/);
    const questions = JSON.parse((await cli(['questions', 'qs101'])).stdout);
    assert.deepEqual(questions.questions.map((q) => [q.key, q.state]), [['q-cover-ratio', 'handled'], ['q-sold-out', 'handled'], ['q-badge-colour', 'open']]);
    assert.equal(questions.questions[0].answer, 'Square.');
  });

  test('a revoked token is exit 4, never a quiet fall back to local rules', async () => {
    const id = (await h.db.query("select id from api_token where label = 'laptop'")).rows[0].id;
    await ann.post('/settings/tokens/revoke', { form: { id } });
    const res = await cli(['claim', 'batch-4']);
    assert.equal(res.code, 4);
    assert.match(res.text, /refused the token/);
    assert.ok(!existsSync(join(out, 'batches', 'batch-4.lock')));

    token = /tfp_[A-Za-z0-9_-]+/.exec(await (await ann.post('/settings/tokens', { form: { label: 'laptop 2' } })).text())[0];
    assert.equal((await cli(['login', h.origin], { stdin: `${token}\n` })).code, 0);
  });

  test('archive, as /taskflow:clean will call it: the page empties, the answers stay with the project', async () => {
    const res = await cli(['archive']);
    assert.equal(res.code, 0, res.text);
    assert.match(res.stdout, /archived this cycle as 2026-02-02/);
    assert.equal((await model()).cycle.empty, true);
    assert.equal((await h.db.query("select count(*)::int as n from answer where project_id = 'harbor'")).rows[0].n, 5);
  });

  test('the server gone: exit 4, and nothing is claimed', async () => {
    await h.app.close();
    const res = await cli(['claim', 'batch-4']);
    assert.equal(res.code, 4);
    assert.match(res.text, /not answering/);
    assert.match(res.text, /nothing was started or changed/i);
    assert.ok(!existsSync(join(out, 'batches', 'batch-4.lock')));
  });
});
