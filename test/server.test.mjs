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
  const ID = 'verify-close:hb121:fixed';
  let item;

  before(async () => {
    item = (await (await fetch(`${base}/api/model`)).json()).inbox[ID];
  });

  test('verified parks the item as waiting, and it persists to the cycle', async () => {
    const res = await tick({ id: ID, resolution: 'verified', fingerprint: item.fingerprint, note: 'checked on staging' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).item.state, 'waiting');
    const file = JSON.parse(await readFile(join(dir, 'report-inbox.sam.json'), 'utf8'));
    assert.equal(file.items[ID].resolution, 'verified');
    assert.equal(file.items[ID].note, 'checked on staging');
    assert.equal(file.cycle, '2026-01-14');
  });

  test('closed finishes it; null unticks it', async () => {
    assert.equal((await (await tick({ id: ID, resolution: 'closed', fingerprint: item.fingerprint })).json()).item.state, 'handled');
    assert.equal((await (await tick({ id: ID, resolution: null })).json()).item.state, 'open');
  });

  test('rejections', async () => {
    assert.equal((await tick({ id: ID, resolution: 'verified', fingerprint: 'wrong' })).status, 409, 'stale fingerprint');
    assert.equal((await tick({ id: ID, resolution: 'sent', fingerprint: item.fingerprint })).status, 400, 'wrong resolution for the kind');
    assert.equal((await tick({ id: 'question:nope:question', resolution: 'sent' })).status, 404);
    assert.equal((await tick({ id: 'stale-lock:batch-9:lock', resolution: 'done' })).status, 400, 'derived items are not tickable');
    assert.equal((await tick({ id: ID, resolution: 'verified', fingerprint: item.fingerprint }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await tick({ id: ID, resolution: 'verified', fingerprint: item.fingerprint }, { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await tick({ id: ID, resolution: 'verified', fingerprint: item.fingerprint }, undefined, '?cycle=2025-12-01')).status, 403, 'archives are read-only');
  });

  test('pipeline state files are never written', async () => {
    const before = await readFile(join(dir, 'state.sam.json'), 'utf8');
    await tick({ id: ID, resolution: 'verified', fingerprint: item.fingerprint });
    assert.equal(await readFile(join(dir, 'state.sam.json'), 'utf8'), before);
  });
});

describe('answers', () => {
  const ID = 'question:hb108:question';
  const JSON_HEADERS = { 'Content-Type': 'application/json' };
  const post = (path, body, headers = JSON_HEADERS, query = '') => fetch(`${base}${path}${query}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const answer = (body, headers, query) => post('/api/answer', body, headers, query);
  const stored = async () => JSON.parse(await readFile(join(dir, 'answers.json'), 'utf8')).items[ID];
  let item;

  before(async () => {
    item = (await (await fetch(`${base}/api/model`)).json()).inbox[ID];
  });

  test('an open blocking question holds its batch', async () => {
    assert.deepEqual([item.state, item.blocking, item.resolutions], ['open', true, ['sent', 'dropped']]);
    assert.equal((await (await fetch(`${base}/api/model`)).json()).batches['batch-6'].laneReason, 'waiting-on-answers');
  });

  test('a tick cannot answer a question', async () => {
    const res = await tick({ id: ID, resolution: 'answered', fingerprint: item.fingerprint });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /saving an answer/);
  });

  test('sent is recorded with the answers, not in the cycle file', async () => {
    assert.equal((await (await tick({ id: ID, resolution: 'sent', fingerprint: item.fingerprint })).json()).item.state, 'waiting');
    assert.equal((await stored()).resolution, 'sent');
    const cycleFile = JSON.parse(await readFile(join(dir, 'report-inbox.sam.json'), 'utf8'));
    assert.equal(cycleFile.items[ID], undefined);
  });

  test('saving an answer settles it and frees the batch', async () => {
    const res = await answer({ id: ID, fingerprint: item.fingerprint, body: 'Orders **1042** and 1051, both with a pre-order.', source: 'Mara, by phone', idempotencyKey: 'draft-1', previousAnswerId: null });
    assert.equal(res.status, 200);
    const saved = (await res.json()).item;
    assert.equal(saved.state, 'handled');
    assert.match(saved.answer.bodyHtml, /<strong>1042<\/strong>/);
    assert.equal(saved.answer.source, 'Mara, by phone');
    const model = await (await fetch(`${base}/api/model`)).json();
    assert.equal(model.batches['batch-6'].lane, 'ready');
    assert.equal((await stored()).answers[0].questionText, item.text);
  });

  test('a double submit is one answer', async () => {
    const again = await answer({ id: ID, fingerprint: item.fingerprint, body: 'Orders **1042** and 1051, both with a pre-order.', idempotencyKey: 'draft-1', previousAnswerId: null });
    assert.equal(again.status, 200);
    assert.equal((await stored()).answers.length, 1);
  });

  test('a second tab that has not seen the first answer is refused', async () => {
    const res = await answer({ id: ID, fingerprint: item.fingerprint, body: 'Something else.', idempotencyKey: 'draft-2', previousAnswerId: null });
    assert.equal(res.status, 409);
    assert.equal((await stored()).answers.length, 1);
  });

  test('markup in an answer is shown as text', async () => {
    const seen = (await stored()).answers.at(-1).id;
    const res = await answer({ id: ID, fingerprint: item.fingerprint, body: '<img src=x onerror=alert(1)> and [x](javascript:alert(1))', idempotencyKey: 'draft-3', previousAnswerId: seen });
    const html = (await res.json()).item.answer.bodyHtml;
    assert.ok(!/<img|href="javascript/i.test(html), html);
  });

  test('a drop needs a reason; reopening keeps the history', async () => {
    assert.equal((await tick({ id: ID, resolution: 'dropped', fingerprint: item.fingerprint })).status, 400);
    assert.equal((await (await tick({ id: ID, resolution: 'dropped', fingerprint: item.fingerprint, note: 'Mara says it no longer happens.' })).json()).item.state, 'handled');
    const reopened = (await (await tick({ id: ID, resolution: null })).json()).item;
    assert.deepEqual([reopened.state, reopened.answer, reopened.answers.length], ['open', null, 2]);
  });

  test('rejections', async () => {
    assert.equal((await answer({ id: ID, fingerprint: 'wrong', body: 'x' })).status, 409, 'stale fingerprint');
    assert.equal((await answer({ id: ID, fingerprint: item.fingerprint, body: '   ' })).status, 400, 'empty');
    assert.equal((await answer({ id: ID, fingerprint: item.fingerprint, body: 'y'.repeat(8001) })).status, 413, 'oversize is refused, not cut');
    assert.equal((await answer({ id: 'verify-close:hb121:fixed', fingerprint: 'x', body: 'x' })).status, 400, 'only questions take answers');
    assert.equal((await answer({ id: 'question:nope:question', body: 'x' })).status, 404);
    assert.equal((await answer({ id: ID, fingerprint: item.fingerprint, body: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await answer({ id: ID, fingerprint: item.fingerprint, body: 'x' }, { ...JSON_HEADERS, Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await answer({ id: ID, fingerprint: item.fingerprint, body: 'x' }, JSON_HEADERS, '?cycle=2025-12-01')).status, 403, 'archives are read-only');
    assert.equal((await post('/api/answer/confirm', { id: ID, fingerprint: item.fingerprint })).status, 400, 'nothing changed, nothing to confirm');
  });

  test('neither the index nor the cycle tick file is touched by an answer', async () => {
    const before = await readFile(join(dir, 'state.sam.json'), 'utf8');
    await answer({ id: ID, fingerprint: item.fingerprint, body: 'Final word.', idempotencyKey: 'draft-4' });
    assert.equal(await readFile(join(dir, 'state.sam.json'), 'utf8'), before);
  });
});

test('confirming a reworded question keeps its answer and frees the batch', async () => {
  const qDir = await materializeTemp(specs.questions);
  const qApp = await createApp({ dir: qDir, version: 'test' });
  const qBase = `http://127.0.0.1:${await qApp.listen(0)}`;
  const ID = 'question:qs106:q-author-order';
  try {
    const before = await (await fetch(`${qBase}/api/model`)).json();
    assert.deepEqual([before.inbox[ID].state, before.batches['batch-6'].laneReason], ['changed', 'waiting-on-answers']);

    const res = await fetch(`${qBase}/api/answer/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ID, fingerprint: before.inbox[ID].fingerprint }) });
    assert.equal(res.status, 200);
    const item = (await res.json()).item;
    assert.deepEqual([item.state, item.answer.body], ['handled', 'Newest first.']);
    assert.equal((await (await fetch(`${qBase}/api/model`)).json()).batches['batch-6'].lane, 'ready');
  } finally {
    await qApp.close();
    await rm(qDir, { recursive: true, force: true });
  }
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
