// handler.mjs over a backend that lives in memory: proof that the routes need no
// directory behind them, which is what lets a database stand in for one.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openCycleFrom } from '../scripts/report/cycle.mjs';
import { createReportHandler, sendError } from '../scripts/report/handler.mjs';
import { question, rawCycle, task } from './helpers/raw.mjs';

const PREFIX = '/p/demo/u/sam';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function memoryBackend() {
  const raw = rawCycle({
    tasks: { t1: task('t1', { batch: 'batch-1', needs: [question('q-colour')] }) },
    batches: { 'batch-1': { tasks: ['t1'] } },
  });
  raw.cycle.dir = null;
  raw.plans.t1 = { bytes: 12, mtimeMs: 1, markdown: '## Approach\n\nPaint it.' };
  raw.attachments.t1 = [{ name: 'shot.png', type: 'image/png', bytes: PNG.length }];
  raw.summaryFile = 'triage-sam.md';

  const records = { items: {}, problems: [] };
  const written = [];
  let revision = 0;
  const human = (actor) => ({
    async load() { return records; },
    async setResolution(item, change) { written.push({ actor, id: item.id, ...change }); revision++; },
    async addAnswer(item, answer) {
      written.push({ actor, id: item.id, body: answer.body });
      records.items[item.id] = { taskId: 't1', key: 'q-colour', resolution: 'answered', fingerprint: item.fingerprint, title: item.title, text: item.text, note: '', at: '2026-02-02T00:00:00.000Z', answers: [{ id: 'a1', at: '2026-02-02T00:00:00.000Z', body: answer.body, source: '', via: 'web' }] };
      revision++;
    },
    async confirm() {},
  });

  const source = openCycleFrom({ reader: { read: async () => raw }, humanFor: (_raw, actor) => human(actor) });
  const opened = [];
  return {
    written,
    opened,
    bump: () => { revision++; raw.index.tasks.t1.name = `Task t1, take ${revision}`; },
    listCycles: async () => [{ id: 'live', isArchive: false }, { id: '2026-01-01', isArchive: true, label: 'January' }],
    openCycle(entry) {
      return {
        id: entry.id,
        isArchive: entry.isArchive,
        signature: async () => String(revision),
        build: () => source.build(),
        human: (actor) => source.humanAs(actor),
        readSummary: async () => '# Notes\n\nAll good.',
        async openAttachment(taskId, name) {
          if (taskId !== 't1' || name !== 'shot.png') return null;
          return { etag: 'abc123', open: async () => { opened.push(name); return PNG; } };
        },
      };
    },
    watch: () => ({ close() {} }),
  };
}

/** A transport that mounts the handler under a prefix, as the hosted server will. */
async function mount(options = {}) {
  const backend = memoryBackend();
  const handler = await createReportHandler({ backend, ...options });
  const server = createServer((req, res) => {
    (async () => {
      const url = new URL(req.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (!path.startsWith(`${PREFIX}/`)) return sendError(res, Object.assign(new Error('Not found.'), { status: 404 }));
      await handler.handle(req, res, { path: path.slice(PREFIX.length), url, actor: options.actor ?? null });
    })().catch((error) => sendError(res, error));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}/`;
  return {
    backend,
    handler,
    base,
    get: (path, headers = {}) => fetch(new URL(path, base), { headers }),
    post: (path, body, headers = {}) => fetch(new URL(path, base), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    async close() {
      handler.close();
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}

describe('reads, with no directory anywhere', () => {
  let app;
  before(async () => { app = await mount(); });
  after(() => app.close());

  test('the page and its assets resolve under the prefix through relative URLs', async () => {
    const page = await app.get('');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await app.get('app.js')).status, 200);
    assert.equal((await app.get('fonts/nope.woff2')).status, 404);
  });

  test('model, with an ETag that round-trips', async () => {
    const first = await app.get('api/model');
    assert.equal(first.status, 200);
    const model = await first.json();
    assert.equal(model.batches['batch-1'].lane, 'blocked');
    assert.equal(model.cycle.dir, null);
    const again = await app.get('api/model', { 'If-None-Match': first.headers.get('etag') });
    assert.equal(again.status, 304);
  });

  test('task detail and summary come from the backend, not from disk', async () => {
    const detail = await (await app.get('api/task/t1')).json();
    assert.equal(detail.sections[0].title, 'Approach');
    assert.deepEqual(detail.attachments.map((a) => a.url), ['attachments/t1/shot.png']);
    const summary = await (await app.get('api/summary')).json();
    assert.equal(summary.file, 'triage-sam.md');
    assert.match(summary.html, /All good/);
  });

  test('cycles carry a label only when the backend gives one', async () => {
    const { cycles } = await (await app.get('api/cycles')).json();
    assert.deepEqual(cycles, [{ id: 'live', isArchive: false }, { id: '2026-01-01', isArchive: true, label: 'January' }]);
    assert.equal((await app.get('api/model?cycle=1999-01-01')).status, 404);
  });

  test('an attachment: type from the name, sandboxed, same-origin only, and not read again on an ETag hit', async () => {
    const res = await app.get('attachments/t1/shot.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-security-policy'), /^sandbox;/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);

    const before = app.backend.opened.length;
    const cached = await app.get('attachments/t1/shot.png', { 'If-None-Match': res.headers.get('etag') });
    assert.equal(cached.status, 304);
    assert.equal(app.backend.opened.length, before);
  });

  test('names the backend never sees: wrong type, unsafe name, encoded twice', async () => {
    const seen = app.backend.opened.length;
    assert.equal((await app.get('attachments/t1/notes.exe')).status, 404);
    assert.equal((await app.get('attachments/t1/.hidden.png')).status, 404);
    assert.equal((await app.get('attachments/%252e%252e/shot.png')).status, 404);
    assert.equal((await app.get('api/task/%252e%252e')).status, 404);
    assert.equal(app.backend.opened.length, seen);
  });

  test('the raw index is not served unless asked for', async () => {
    assert.equal((await app.get('api/status')).status, 404);
  });
});

describe('writes', () => {
  test('refused before the body is read when the caller may not write', async () => {
    const app = await mount({ canWrite: () => false });
    try {
      // Not JSON at all: a handler that read the body first would answer 400.
      const res = await fetch(new URL('api/answer', app.base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
      assert.equal(res.status, 403);
      assert.deepEqual(app.backend.written, []);
    } finally {
      await app.close();
    }
  });

  test('the transport decides which Origin is allowed, including none at all', async () => {
    const app = await mount({ security: { originAllowed: (origin) => origin === 'https://flow.example.com' } });
    try {
      const { inbox } = await (await app.get('api/model')).json();
      const item = Object.values(inbox).find((i) => i.kind === 'question');
      const body = { id: item.id, fingerprint: item.fingerprint, body: 'Blue.' };
      assert.equal((await app.post('api/answer', body)).status, 403);
      assert.equal((await app.post('api/answer', body, { Origin: 'https://evil.example.com' })).status, 403);
      assert.equal((await app.post('api/answer', body, { Origin: 'https://flow.example.com' })).status, 200);
    } finally {
      await app.close();
    }
  });

  test('the store is asked for on behalf of the actor, and the answer frees the batch', async () => {
    const actor = { id: '7', login: 'sam' };
    const app = await mount({ actor, canWrite: (who) => who === actor });
    try {
      const { inbox } = await (await app.get('api/model')).json();
      const item = Object.values(inbox).find((i) => i.kind === 'question');
      const res = await app.post('api/answer', { id: item.id, fingerprint: item.fingerprint, body: 'Blue.' });
      assert.equal(res.status, 200);
      assert.deepEqual(app.backend.written, [{ actor, id: item.id, body: 'Blue.' }]);
      assert.equal((await (await app.get('api/model')).json()).batches['batch-1'].lane, 'ready');
    } finally {
      await app.close();
    }
  });
});

test('notify() announces a new version to open streams', async () => {
  const app = await mount();
  try {
    const first = await (await app.get('api/model')).json();
    const stream = await app.get('api/events');
    const reader = stream.body.getReader();
    await reader.read(); // "retry: 3000"
    app.backend.bump();
    await app.handler.notify();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /^event: model/);
    assert.notEqual(JSON.parse(chunk.split('data: ')[1]).version, first.version);
    await reader.cancel();
  } finally {
    await app.close();
  }
});
