// The local report server: the report's routes (handler.mjs) over a cycle
// directory (backend-files.mjs), on a loopback socket.
//
// The page shows client ticket text, so the server is closed by default:
// loopback only, Host allowlist (DNS rebinding), strict CSP, and an Origin +
// content-type check on the write routes (CSRF).

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createFileBackend } from './backend-files.mjs';
import { HttpError, createReportHandler, sendError, sendJson } from './handler.mjs';

export async function createApp({ dir, slug = null, project = null, version = 'dev', enrich = null, scriptPath = null }) {
  const root = resolve(dir);
  const startedAt = new Date().toISOString();
  let port = null;

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const handler = await createReportHandler({
    backend: createFileBackend({ dir: root, slug, project, enrich }),
    legacyStatus: true,
    // A missing Origin is a same-origin GET-style client or a script on this machine; a present one must be ours.
    security: { originAllowed: (origin) => !origin || [...allowedHosts()].some((host) => origin === `http://${host}`) },
  });

  async function route(req, res) {
    if (!allowedHosts().has(req.headers.host ?? '')) throw new HttpError(403, 'Unexpected Host header.');

    const url = new URL(req.url, 'http://localhost');
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Malformed path.');
    }

    if (path === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(res, 200, { ok: true, name: 'taskflow-report', version, scriptPath, pid: process.pid, port, dir: root, startedAt });
    }
    return handler.handle(req, res, { path, url, actor: null });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => sendError(res, error));
  });

  return {
    server,
    getState: handler.getState,
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
      handler.close();
      // Open SSE streams would otherwise keep close() waiting forever.
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}
