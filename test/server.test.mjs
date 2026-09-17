import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../scripts/report/server.mjs';
import { specs } from './fixtures/specs.mjs';
import { materializeTemp } from './helpers/cycle.mjs';

let dir;
let app;
let base;
let port;

before(async () => {
  dir = await materializeTemp(specs['kitchen-sink']);
  app = await createApp({ dir, version: 'test' });
  port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

/** fetch() cannot set Host, and normalises "..", so raw requests go through node:http. */
function raw(path, { host = `127.0.0.1:${port}`, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const tick = (body, headers = { 'Content-Type': 'application/json' }, query = '') =>
  fetch(`${base}/api/inbox${query}`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('surface', () => {
  test('binds to loopback only', () => {
    assert.equal(app.server.address().address, '127.0.0.1');
  });

  test('the page ships a strict CSP', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('an unexpected Host header is refused (DNS rebinding)', async () => {
    assert.equal((await raw('/api/model', { host: 'evil.example.com' })).status, 403);
    assert.equal((await raw('/api/model', { host: `localhost:${port}` })).status, 200);
  });

  test('health names the running version', async () => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.name, 'taskflow-report');
    assert.equal(health.version, 'test');
    assert.equal(health.port, port);
  });

  test('only GET, HEAD and the inbox POST exist', async () => {
    assert.equal((await raw('/api/model', { method: 'DELETE' })).status, 405);
    assert.equal((await raw('/nope')).status, 404);
  });
});

describe('model', () => {
  test('ETag round trip', async () => {
    const first = await fetch(`${base}/api/model`);
    const etag = first.headers.get('etag');
    const model = await first.json();
    assert.equal(etag, `"${model.version}"`);
    assert.equal((await fetch(`${base}/api/model`, { headers: { 'If-None-Match': etag } })).status, 304);
  });

  test('archives are listed and selected by enumeration, never by path', async () => {
    const { cycles } = await (await fetch(`${base}/api/cycles`)).json();
    assert.deepEqual(cycles, [{ id: 'live', isArchive: false }, { id: '2025-12-01', isArchive: true }]);
    const archived = await (await fetch(`${base}/api/model?cycle=2025-12-01`)).json();
    assert.equal(archived.cycle.readOnly, true);
    assert.equal(archived.counts.batches, 6);
    for (const bad of ['../..', '..%2f..', 'archive', '2025-12-01/../..']) {
      assert.equal((await raw(`/api/model?cycle=${bad}`)).status, 404, bad);
    }
  });

  test('task detail, summary and the legacy status shape', async () => {
    const detail = await (await fetch(`${base}/api/task/hb101`)).json();
    assert.ok(detail.sections.length > 3);
    assert.equal((await fetch(`${base}/api/task/nope`)).status, 404);

    const summary = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(summary.file, 'triage-sam-2026-01-14.md');
    assert.match(summary.html, /Triage summary/);

    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.batches['batch-3'].locked, true);
    assert.equal(status.index.developer, 'Sam Rivera');
  });
});

describe('attachments', () => {
  test('served with a sandbox policy, so a hostile SVG cannot run script', async () => {
    const res = await fetch(`${base}/attachments/hb101/diagram.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.match(res.headers.get('content-security-policy'), /^sandbox;/);
  });

  test('traversal, unknown types and escaping symlinks all 404', async () => {
    await symlink(join(dir, 'state.sam.json'), join(dir, 'attachments', 'hb101', 'leak.png'));
    for (const path of [
      '/attachments/hb101/notes.exe',
      '/attachments/hb101/leak.png',
      '/attachments/..%2f..%2fstate.sam.json',
      '/attachments/hb101/..%2f..%2fstate.sam.json',
      '/attachments/%2e%2e/%2e%2e/state.sam.json',
      '/attachments/hb101/%00.png',
      '/attachments/hb101/missing.png',
    ]) {
      const res = await raw(path);
      assert.ok([400, 404].includes(res.status), `${path} -> ${res.status}`);
      assert.ok(!res.body.includes('Sam Rivera'), path);
    }
    assert.equal((await raw('/attachments/%E0%A4%A/x.png')).status, 400);
  });
});

describe('inbox ticks', () => {
  const ID = 'question:hb108:question';
  let item;

  before(async () => {
    item = (await (await fetch(`${base}/api/model`)).json()).inbox[ID];
  });

  test('sent parks the question as waiting, and it persists to disk', async () => {
    const res = await tick({ id: ID, resolution: 'sent', fingerprint: item.fingerprint, note: 'asked in chat' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).item.state, 'waiting');
    const file = JSON.parse(await readFile(join(dir, 'report-inbox.sam.json'), 'utf8'));
    assert.equal(file.items[ID].resolution, 'sent');
    assert.equal(file.items[ID].note, 'asked in chat');
    assert.equal(file.cycle, '2026-01-14');
  });

  test('answered finishes it; null unticks it', async () => {
    assert.equal((await (await tick({ id: ID, resolution: 'answered', fingerprint: item.fingerprint })).json()).item.state, 'handled');
    assert.equal((await (await tick({ id: ID, resolution: null })).json()).item.state, 'open');
  });

  test('rejections', async () => {
    assert.equal((await tick({ id: ID, resolution: 'sent', fingerprint: 'wrong' })).status, 409, 'stale fingerprint');
    assert.equal((await tick({ id: ID, resolution: 'closed', fingerprint: item.fingerprint })).status, 400, 'wrong resolution for the kind');
    assert.equal((await tick({ id: 'question:nope:question', resolution: 'sent' })).status, 404);
    assert.equal((await tick({ id: 'stale-lock:batch-9:lock', resolution: 'done' })).status, 400, 'derived items are not tickable');
    assert.equal((await tick({ id: ID, resolution: 'sent', fingerprint: item.fingerprint }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await tick({ id: ID, resolution: 'sent', fingerprint: item.fingerprint }, { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await tick({ id: ID, resolution: 'sent', fingerprint: item.fingerprint }, undefined, '?cycle=2025-12-01')).status, 403, 'archives are read-only');
  });

  test('pipeline state files are never written', async () => {
    const before = await readFile(join(dir, 'state.sam.json'), 'utf8');
    await tick({ id: ID, resolution: 'sent', fingerprint: item.fingerprint });
    assert.equal(await readFile(join(dir, 'state.sam.json'), 'utf8'), before);
  });
});

test('live updates announce a new version when a batch is claimed', async () => {
  const { mkdir } = await import('node:fs/promises');
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  const started = Date.now();

  await mkdir(join(dir, 'batches', 'batch-5.lock'));

  let text = '';
  while (!text.includes('event: model') && Date.now() - started < 5000) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString('utf8');
  }
  controller.abort();
  assert.match(text, /event: model\ndata: \{"version":"[0-9a-f]{12}"\}/);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);

  const model = await (await fetch(`${base}/api/model`)).json();
  assert.equal(model.batches['batch-5'].laneReason, 'claiming');
});
