import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { specs } from '../../test/fixtures/specs.mjs';
import { roundTrip } from '../../test/helpers/trip.mjs';
import { createHostedApp } from '../app.mjs';
import { readConfig } from '../config.mjs';
import { testDb } from './helpers/db.mjs';
import { push } from './helpers/push.mjs';
import { seedProject, seedUser } from './helpers/seed.mjs';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.mjs');

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/** fetch() cannot set Host and tidies paths. This sends exactly what it is given. */
const raw = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
  req.on('error', reject);
  req.end();
});

/**
 * A hosted app over a pushed fixture. `signIn` stands in for sessions, which do not exist yet:
 * a test names the user in a header. No such code exists in the server.
 */
async function start(spec, { signIn = false, readOnly } = {}) {
  const t = await testDb();
  const trip = await roundTrip(spec);
  const { projectId, user } = await seedProject(t.db);
  await push(t.db, { projectId, userId: user.id, payload: trip.wire, blobs: trip.blobs });

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const resolveActor = signIn
    ? async (req) => (await t.db.query('select id, login from app_user where login = $1', [req.headers['x-test-user'] ?? ''])).rows[0] ?? null
    : undefined;
  const app = createHostedApp({ db: t.db, publicUrl: origin, version: '9.9.9', resolveActor, ...(readOnly === undefined ? {} : { readOnly }) });
  await app.listen({ host: '127.0.0.1', port });

  const base = `${origin}/p/${projectId}/u/${user.login}/`;
  return {
    t, trip, app, port, origin, base, projectId, user,
    get: (path, headers = {}) => fetch(new URL(path, base), { headers, redirect: 'manual' }),
    post: (path, body, { as = user.login, headers = { Origin: origin } } = {}) => fetch(new URL(path, base), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': as, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    close: async () => { await app.close(); await t.close(); await rm(trip.dir, { recursive: true, force: true }); },
  };
}

describe('the hosted dashboard, read', () => {
  let s;
  before(async () => { s = await start(specs['kitchen-sink']); });
  after(() => s.close());

  test('health says its name and version, and nothing about the machine', async () => {
    const res = await fetch(`${s.origin}/api/health`);
    assert.deepEqual(await res.json(), { ok: true, name: 'taskflow', version: '9.9.9' });
    assert.equal((await fetch(`${s.origin}/api/health`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${s.origin}/api/health`, { method: 'POST' })).status, 404);
  });

  test('the page, its assets and its data all resolve under the project path', async () => {
    const page = await s.get('');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*form-action 'none'/);
    for (const asset of ['app.js', 'styles.css', 'theme.js']) assert.equal((await s.get(asset)).status, 200, asset);

    const first = await s.get('api/model');
    const model = await first.json();
    assert.deepEqual([model.cycle.hosted, model.cycle.readOnly, model.cycle.dir, model.cycle.pushedFrom], [true, true, null, 'laptop']);
    assert.ok(Object.keys(model.batches).length > 10);
    assert.equal((await s.get('api/model', { 'If-None-Match': first.headers.get('etag') })).status, 304);

    assert.match((await (await s.get('api/summary')).json()).html, /Triage summary/);
    assert.ok((await (await s.get('api/task/hb101')).json()).sections.length > 0);
  });

  test('without the trailing slash, a redirect built from the checked parts; any case of the login works', async () => {
    const res = await fetch(`${s.origin}/p/demo/u/SAM`, { redirect: 'manual' });
    assert.deepEqual([res.status, res.headers.get('location')], [308, '/p/demo/u/sam/']);
    assert.equal((await fetch(`${s.origin}/p/demo/u/SAM/api/model`)).status, 200);
  });

  test('no such project, no such developer, and an answerer as owner all answer the same', async () => {
    await seedUser(s.t.db, s.projectId, { login: 'mara', role: 'answerer' });
    const bodies = [];
    for (const path of ['/p/nowhere/u/sam/', '/p/demo/u/ghost/', '/p/demo/u/mara/', '/p/demo/u/sam%2Fx/', '/p/Demo/u/sam/', '/', '/p/demo/']) {
      const res = await fetch(`${s.origin}${path}`, { redirect: 'manual' });
      assert.equal(res.status, 404, path);
      bodies.push(await res.text());
    }
    assert.equal(new Set(bodies).size, 1);
  });

  test('paths that try to climb, encoded once or twice, reach nothing', async () => {
    for (const path of ['/p/demo/u/sam/attachments/hb101/..%2F..%2Fstate.json', '/p/demo/u/sam/attachments/%2e%2e/before.png', '/p/demo/u/sam/attachments/%252e%252e/before.png', '/p/demo/u/sam/api/task/..%2f..']) {
      assert.equal((await raw(s.port, path, { Host: `127.0.0.1:${s.port}` })).statusCode, 404, path);
    }
    assert.equal((await raw(s.port, '/p/demo/u/sam/%E0%A4%A', { Host: `127.0.0.1:${s.port}` })).statusCode, 400);
  });

  test('the raw index is not served', async () => {
    assert.equal((await s.get('api/status')).status, 404);
  });

  test('a Host the server was not told about is refused', async () => {
    assert.equal((await raw(s.port, '/api/health', { Host: 'evil.example.com' })).statusCode, 403);
    assert.equal((await raw(s.port, '/api/health', { Host: `localhost:${s.port}` })).statusCode, 403, 'only the configured origin');
    assert.equal((await raw(s.port, '/api/health', { Host: `127.0.0.1:${s.port}` })).statusCode, 200);
  });

  test('an attachment comes out of the database typed by its name, sandboxed, and cacheable by its hash', async () => {
    const res = await s.get('attachments/hb101/before.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-security-policy'), /^sandbox;/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('etag'), `"${s.trip.wire.attachments.hb101.find((f) => f.name === 'before.png').sha256}"`);
    assert.ok((await res.arrayBuffer()).byteLength > 20);
    assert.equal((await s.get('attachments/hb101/before.png', { 'If-None-Match': res.headers.get('etag') })).status, 304);

    const svg = await s.get('attachments/hb101/diagram.svg');
    assert.deepEqual([svg.headers.get('content-type'), /^sandbox;/.test(svg.headers.get('content-security-policy'))], ['image/svg+xml', true]);
    assert.equal((await s.get('attachments/hb101/notes.exe')).status, 404, 'never pushed: the reader drops types it does not know');
    assert.equal((await s.get('attachments/hb102/before.png')).status, 404);
  });

  test('every write is refused, before its body is even read', async () => {
    for (const path of ['api/answer', 'api/inbox', 'api/answer/confirm']) {
      const res = await s.post(path, '{not json');
      assert.equal(res.status, 403, path);
    }
  });
});

describe('live updates across processes', () => {
  test('a push from elsewhere reaches an open page; an unchanged one only refreshes its age', async () => {
    const s = await start(specs.questions);
    try {
      const stream = await s.get('api/events');
      const reader = stream.body.getReader();
      const next = async () => new TextDecoder().decode((await reader.read()).value);
      await next(); // retry: 3000

      const changed = structuredClone(s.trip.wire);
      changed.batchFiles['batch-2'].data.status = 'in-progress';
      await push(s.t.open(), { projectId: s.projectId, userId: s.user.id, payload: changed, blobs: s.trip.blobs });

      let seen = '';
      while (!/event: model/.test(seen)) seen += await next();
      assert.match(seen, /event: model/);
      assert.equal((await (await s.get('api/model')).json()).batches['batch-2'].status, 'in-progress');

      const version = (await (await s.get('api/model')).json()).version;
      await push(s.t.open(), { projectId: s.projectId, userId: s.user.id, payload: changed, blobs: s.trip.blobs });
      seen = '';
      while (!/event: pushed/.test(seen)) seen += await next();
      assert.doesNotMatch(seen.slice(seen.lastIndexOf('event: pushed')), /event: model/);
      assert.equal((await (await s.get('api/model')).json()).version, version);
      await reader.cancel();
    } finally {
      await s.close();
    }
  });
});

describe('writes, with a stand-in for sign-in', () => {
  const ID = 'question:qs101:q-cover-ratio';
  let s;
  let item;
  before(async () => {
    s = await start(specs.questions, { signIn: true, readOnly: false });
    item = (await (await s.get('api/model')).json()).inbox[ID];
  });
  after(() => s.close());

  const answer = (extra = {}) => ({ id: ID, fingerprint: item.fingerprint, body: 'Square.', ...extra });

  test('the page is told it may write', async () => {
    assert.equal((await (await s.get('api/model')).json()).cycle.readOnly, false);
  });

  test('the page\'s own origin, stated: anything else is refused', async () => {
    assert.equal((await s.post('api/answer', answer(), { headers: {} })).status, 403, 'no Origin at all');
    assert.equal((await s.post('api/answer', answer(), { headers: { Origin: 'null' } })).status, 403);
    assert.equal((await s.post('api/answer', answer(), { headers: { Origin: 'https://evil.example.com' } })).status, 403);
  });

  test('somebody who is not in the project, and nobody at all', async () => {
    await s.t.db.query("insert into app_user (login) values ('stranger')");
    assert.equal((await s.post('api/answer', answer(), { as: 'stranger' })).status, 403);
    assert.equal((await s.post('api/answer', answer(), { as: 'no-such-user' })).status, 403);
    assert.equal((await (await s.get('api/model')).json()).inbox[ID].state, 'open');
  });

  test('an answerer\'s answer is taken and changes nothing yet', async () => {
    await seedUser(s.t.db, s.projectId, { login: 'mara', role: 'answerer' });
    assert.equal((await s.post('api/answer', answer({ body: 'Square, I think.' }), { as: 'mara' })).status, 200);
    assert.equal((await (await s.get('api/model')).json()).inbox[ID].state, 'open');
  });

  test('a developer\'s answer settles the question, under their name', async () => {
    const res = await s.post('api/answer', answer({ previousAnswerId: null }));
    assert.equal(res.status, 200);
    const saved = (await res.json()).item;
    assert.deepEqual([saved.state, saved.answer.body], ['handled', 'Square.']);
    const log = await s.t.db.query("select user_id from audit_log where action = 'answer' order by id desc limit 1");
    assert.equal(String(log.rows[0].user_id), String(s.user.id));
  });

  test('ticks and drops go the same way', async () => {
    const model = await (await s.get('api/model')).json();
    const sent = model.inbox['question:qs103:q-points-expiry'];
    assert.equal((await s.post('api/inbox', { id: sent.id, fingerprint: sent.fingerprint, resolution: 'dropped' })).status, 400, 'a drop needs a reason');
    assert.equal((await s.post('api/inbox', { id: sent.id, fingerprint: sent.fingerprint, resolution: 'dropped', note: 'Out of scope for now.' })).status, 200);
    assert.equal((await s.post('api/inbox', { id: sent.id, fingerprint: 'stale', resolution: 'sent' })).status, 409);
  });
});

describe('what the server will start on', () => {
  const env = (PUBLIC_URL) => ({ DATABASE_URL: 'postgres://x/y', PUBLIC_URL });

  test('loopback, with a port, and nothing else', () => {
    assert.deepEqual(readConfig(env('http://127.0.0.1:3900')).bind, { host: '127.0.0.1', port: 3900 });
    assert.deepEqual(readConfig(env('http://localhost:3900')).bind, { host: '127.0.0.1', port: 3900 }, 'the bind address is never taken from the URL');
    for (const url of ['https://flow.example.com', 'http://127.0.0.1.evil.example.com:3900', 'http://0.0.0.0:3900', 'http://192.168.1.10:3900', 'https://127.0.0.1:3900', 'http://127.0.0.1', 'http://user:pw@127.0.0.1:3900', 'http://127.0.0.1:3900/path', 'http://127.0.0.1:3900/?x=1', 'not a url']) {
      assert.throws(() => readConfig(env(url)), (error) => error.config === true, url);
    }
    assert.throws(() => readConfig({ PUBLIC_URL: 'http://127.0.0.1:3900' }), /DATABASE_URL/);
    assert.equal(readConfig({ ...env('http://127.0.0.1:3900'), HOST: '0.0.0.0', PORT: '80' }).bind.host, '127.0.0.1', 'a stray HOST cannot open it up');
  });

  test('main.mjs exits 1 on a public URL and says why, before it touches the database', () => {
    const run = spawnSync(process.execPath, [MAIN], { env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', PUBLIC_URL: 'https://flow.example.com' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /No sign-in is configured/);
  });
});
