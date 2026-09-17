// HTTP layer for the report. Read-only over pipeline state; the single write
// route ticks inbox items into report-inbox.<slug>.json.
//
// The page shows client ticket text, so the server is closed by default:
// loopback only, Host allowlist (DNS rebinding), strict CSP, and an Origin +
// content-type check on the write route (CSRF).

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel, buildTaskDetail } from './model.mjs';
import { renderMarkdown } from './markdown.mjs';
import { attachmentType, createReader, findProject, listCycles } from './read.mjs';
import { createTickStore } from './ticks.mjs';
import { computeSignature, createWatcher } from './watch.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_BODY_BYTES = 16 * 1024;
const REBUILD_EVERY_MS = 30 * 1000; // lock ages cross thresholds without any file changing
const HEARTBEAT_MS = 25 * 1000;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

// Attachments come from the ticket provider. `sandbox` stops an SVG from
// running script even when it is opened directly in a tab.
const ATTACHMENT_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The files the page may load: fixed at startup, never derived from a request path. */
async function buildStaticMap() {
  const map = new Map([['/', 'index.html']]);
  for (const name of await readdir(UI_DIR).catch(() => [])) {
    if (STATIC_TYPES[extname(name)]) map.set(`/${name}`, name);
  }
  for (const name of await readdir(join(UI_DIR, 'fonts')).catch(() => [])) {
    if (STATIC_TYPES[extname(name)]) map.set(`/fonts/${name}`, join('fonts', name));
  }
  return map;
}

export async function createApp({ dir, slug = null, project = null, version = 'dev', enrich = null, scriptPath = null }) {
  const root = resolve(dir);
  const found = findProject(root);
  const projectRoot = project ? resolve(project) : found.root;
  const staticMap = await buildStaticMap();
  const startedAt = new Date().toISOString();
  const cycles = new Map();
  const clients = new Set();
  let port = null;
  let lastBroadcast = null;

  async function getCycle(id) {
    const known = await listCycles(root);
    // Validate by enumerating what exists; a cycle id is never joined into a path.
    const entry = known.find((c) => c.id === (id || 'live'));
    if (!entry) throw new HttpError(404, 'Unknown cycle.');
    if (!cycles.has(entry.id)) {
      cycles.set(entry.id, {
        ...entry,
        reader: createReader(entry.dir, { slug: entry.isArchive ? null : slug, cycleId: entry.id, isArchive: entry.isArchive, config: found.config }),
        ticks: null,
        cache: null,
        building: null,
      });
    }
    return cycles.get(entry.id);
  }

  async function getState(id, { force = false } = {}) {
    const cycle = await getCycle(id);
    if (cycle.building) return cycle.building;
    const signature = await computeSignature(cycle.dir);
    const enrichVersion = enrich?.version() ?? 0;
    const fresh = cycle.cache && cycle.cache.signature === signature && cycle.cache.enrichVersion === enrichVersion &&
      Date.now() - cycle.cache.builtAt < REBUILD_EVERY_MS;
    if (fresh && !force) return cycle.cache;

    cycle.building = (async () => {
      const raw = await cycle.reader.read();
      cycle.ticks ??= createTickStore(cycle.dir, raw.cycle.slug, { readOnly: cycle.isArchive });
      const ticks = await cycle.ticks.load(raw.index?.last_triage ?? null);
      const enrichment = enrich ? enrich.snapshot(raw, projectRoot) : null;
      const model = buildModel(raw, { ticks, enrichment });
      cycle.cache = { signature, enrichVersion, builtAt: Date.now(), raw, model };
      return cycle.cache;
    })().finally(() => { cycle.building = null; });
    return cycle.building;
  }

  // -- responses ---------------------------------------------------------------

  function baseHeaders(extra = {}) {
    return { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...extra };
  }

  function sendJson(res, status, body, extra = {}) {
    res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extra }));
    res.end(JSON.stringify(body));
  }

  async function sendStatic(res, relative) {
    const path = join(UI_DIR, relative);
    const body = await readFile(path);
    const type = STATIC_TYPES[extname(path)];
    const headers = baseHeaders({ 'Content-Type': type });
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = PAGE_CSP;
    if (type === 'font/woff2') headers['Cache-Control'] = 'public, max-age=86400';
    res.writeHead(200, headers);
    res.end(body);
  }

  async function sendAttachment(res, cycleId, taskId, name) {
    const type = SAFE_NAME.test(taskId) && SAFE_NAME.test(name) ? attachmentType(name) : null;
    if (!type) throw new HttpError(404, 'No such attachment.');
    const cycle = await getCycle(cycleId);
    const base = join(cycle.dir, 'attachments');
    let real;
    try {
      real = await realpath(join(base, taskId, name));
      // A symlink inside attachments/ must not reach outside it.
      if (!real.startsWith((await realpath(base)) + sep)) throw new Error('outside');
      if (!(await stat(real)).isFile()) throw new Error('not a file');
    } catch {
      throw new HttpError(404, 'No such attachment.');
    }
    res.writeHead(200, baseHeaders({
      'Content-Type': type,
      'Content-Security-Policy': ATTACHMENT_CSP,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=300',
    }));
    createReadStream(real).pipe(res);
  }

  function readBody(req) {
    return new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'Request body too large.')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'Body is not valid JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  async function handleInbox(req, res, cycleId) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send application/json.');
    const origin = req.headers.origin;
    if (origin && ![...allowedHosts()].some((host) => origin === `http://${host}`)) throw new HttpError(403, 'Cross-origin writes are not allowed.');

    const cycle = await getCycle(cycleId);
    if (cycle.isArchive) throw new HttpError(403, 'This cycle is archived and read-only.');
    const body = await readBody(req);
    const { model } = await getState(cycleId);
    const item = model.inbox[body?.id];
    if (!item) throw new HttpError(404, 'That item is no longer in the inbox.');
    if (!item.tickable) throw new HttpError(400, 'This item clears itself once the underlying state is fixed.');

    const resolution = body.resolution ?? null;
    if (resolution !== null && !item.resolutions.includes(resolution)) throw new HttpError(400, `Use one of: ${item.resolutions.join(', ')}.`);
    if (resolution !== null && body.fingerprint !== item.fingerprint) throw new HttpError(409, 'The item changed since you loaded it. Reload and try again.');

    await cycle.ticks.set(item.id, resolution === null ? null : { resolution, fingerprint: item.fingerprint, title: item.title, note: body.note }, model.cycle.lastTriage);
    const next = await getState(cycleId, { force: true });
    broadcast(next.model.version);
    sendJson(res, 200, { ok: true, version: next.model.version, item: next.model.inbox[item.id] ?? null });
  }

  // -- live updates ------------------------------------------------------------

  function broadcast(modelVersion) {
    if (modelVersion === lastBroadcast) return;
    lastBroadcast = modelVersion;
    for (const client of clients) client.write(`event: model\ndata: ${JSON.stringify({ version: modelVersion })}\n\n`);
  }

  async function refreshLive() {
    if (clients.size === 0) return;
    try {
      const { model } = await getState('live', { force: true });
      broadcast(model.version);
    } catch {
      // The next poll retries; a transient read error must not kill the stream.
    }
  }

  const watcher = createWatcher(root, refreshLive);
  const ticker = setInterval(refreshLive, REBUILD_EVERY_MS);
  ticker.unref();
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
  heartbeat.unref();
  enrich?.onChange(refreshLive);

  function handleEvents(req, res) {
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }));
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  // -- routing -----------------------------------------------------------------

  async function route(req, res) {
    if (!allowedHosts().has(req.headers.host ?? '')) throw new HttpError(403, 'Unexpected Host header.');

    const url = new URL(req.url, 'http://localhost');
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Malformed path.');
    }
    const cycleId = url.searchParams.get('cycle') || 'live';

    if (req.method === 'POST' && path === '/api/inbox') return handleInbox(req, res, cycleId);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');

    if (staticMap.has(path)) return sendStatic(res, staticMap.get(path));

    if (path === '/api/health') {
      return sendJson(res, 200, { ok: true, name: 'taskflow-report', version, scriptPath, pid: process.pid, port, dir: root, startedAt });
    }
    if (path === '/api/events') return handleEvents(req, res);
    if (path === '/api/cycles') {
      return sendJson(res, 200, { cycles: (await listCycles(root)).map((c) => ({ id: c.id, isArchive: c.isArchive })) });
    }
    if (path === '/api/model') {
      const { model } = await getState(cycleId);
      const etag = `"${model.version}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, baseHeaders({ ETag: etag })); return res.end(); }
      return sendJson(res, 200, model, { ETag: etag });
    }
    if (path === '/api/summary') {
      const { raw } = await getState(cycleId);
      if (!raw.summaryFile) return sendJson(res, 200, { file: null, html: '', truncated: false });
      const text = await readFile(join(raw.cycle.dir, raw.summaryFile), 'utf8').catch(() => '');
      return sendJson(res, 200, { file: raw.summaryFile, ...renderMarkdown(text) });
    }
    if (path === '/api/status') {
      // Shape of the pre-rework endpoint, kept for anything scripted against it.
      const { raw } = await getState(cycleId);
      if (!raw.index) return sendJson(res, 404, { error: 'No triage data found' });
      const batches = {};
      for (const key of Object.keys(raw.index.batches ?? {})) {
        batches[key] = { ...(raw.batchFiles[key]?.data ?? { status: 'pending', branch: null, pr_url: null, tasks: {} }), locked: Boolean(raw.locks[key]) };
      }
      return sendJson(res, 200, { index: raw.index, batches });
    }

    const task = /^\/api\/task\/([^/]+)$/.exec(path);
    if (task) {
      if (!SAFE_NAME.test(task[1])) throw new HttpError(404, 'No such task.');
      const { raw } = await getState(cycleId);
      if (!raw.index?.tasks?.[task[1]]) throw new HttpError(404, 'No such task.');
      return sendJson(res, 200, buildTaskDetail(raw, task[1]));
    }

    const attachment = /^\/attachments\/([^/]+)\/([^/]+)$/.exec(path);
    if (attachment) return sendAttachment(res, cycleId, attachment[1], attachment[2]);

    throw new HttpError(404, 'Not found.');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: status === 500 ? 'The report hit an internal error. See the server log.' : error.message });
    });
  });

  return {
    server,
    getState,
    enrich,
    /** Bind to loopback, walking up from `wanted` when a port is taken. */
    listen(wanted, attempts = 20) {
      return new Promise((resolveListen, reject) => {
        const tryPort = (candidate, left) => {
          server.once('error', (error) => {
            if (error.code === 'EADDRINUSE' && left > 0 && wanted !== 0) return tryPort(candidate + 1, left - 1);
            reject(error);
          });
          server.listen(candidate, '127.0.0.1', () => {
            server.removeAllListeners('error');
            port = server.address().port;
            resolveListen(port);
          });
        };
        tryPort(wanted, attempts);
      });
    },
    async close() {
      watcher.close();
      clearInterval(ticker);
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
      // Open SSE streams would otherwise keep close() waiting forever.
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}
