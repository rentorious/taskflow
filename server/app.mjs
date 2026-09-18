// The hosted dashboard: many projects, each developer's cycles under their own path.
//
//   /api/health                      name and version, nothing else
//   /p/<project>/u/<login>/...       the report (scripts/report/handler.mjs), mounted
//
// The page's URLs are all relative, so the unchanged client works under that
// prefix. Tenancy is in the path and nowhere else: a request is resolved to one
// project and one owner, and the handler it reaches was built over a backend that
// can address only those two.

import { createServer } from 'node:http';
import { HttpError, baseHeaders, createReportHandler, sendError, sendJson } from '../scripts/report/handler.mjs';
import { ACTIONS, authorize } from './authorize.mjs';
import { createPgBackend } from './backend-pg.mjs';

const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{1,38}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const MOUNT = /^\/p\/([^/]+)\/u\/([^/]+)(\/.*)?$/;
const IDLE_MS = 10 * 60 * 1000;

// One answer for "no such project", "no such developer in it" and "not yours to see": which of them it is stays private.
const notFound = () => new HttpError(404, 'Not found.');

/**
 * @param {object} options
 * @param {object} options.db
 * @param {URL|string} options.publicUrl  the origin people open; Host and Origin are checked against it
 * @param {(req: import('node:http').IncomingMessage) => Promise<{id: string, login: string}|null>} [options.resolveActor]
 *   who is asking. Sessions and tokens will answer this; until they exist nobody is signed in.
 * @param {boolean} [options.readOnly]  tell the page to hide its write controls
 */
export function createHostedApp({ db, publicUrl, version = 'dev', resolveActor = async () => null, readOnly = true }) {
  const home = new URL(publicUrl);
  const allowedHost = home.host.toLowerCase();
  const mounted = new Map(); // "<project>:<owner id>" -> { handler, usedAt }

  async function handlerFor(projectId, ownerId) {
    const key = `${projectId}:${ownerId}`;
    if (!mounted.has(key)) {
      mounted.set(key, {
        usedAt: Date.now(),
        ready: createReportHandler({
          backend: createPgBackend(db, { projectId, ownerId, readOnly }),
          // Cookies will ride on these writes, so the page's own origin is the only one accepted, and it must be stated.
          security: { originAllowed: (origin) => origin === home.origin },
          canWrite: (actor) => authorize(actor, ACTIONS.WRITE_HUMAN),
        }),
      });
    }
    const slot = mounted.get(key);
    slot.usedAt = Date.now();
    return slot.ready;
  }

  const sweeper = setInterval(async () => {
    for (const [key, slot] of mounted) {
      const handler = await slot.ready.catch(() => null);
      if (handler && (handler.clientCount() > 0 || Date.now() - slot.usedAt < IDLE_MS)) continue;
      mounted.delete(key);
      handler?.close();
    }
  }, 60 * 1000);
  sweeper.unref();

  async function route(req, res) {
    if ((req.headers.host ?? '').toLowerCase() !== allowedHost) throw new HttpError(403, 'Unexpected Host header.');

    const url = new URL(req.url, home);
    let path;
    try {
      // Once. An encoded slash becomes a real one here and then simply fails to match.
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Malformed path.');
    }

    if (path === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) return sendJson(res, 200, { ok: true, name: 'taskflow', version });

    const match = MOUNT.exec(path);
    if (!match || !PROJECT_KEY.test(match[1]) || !LOGIN.test(match[2])) throw notFound();
    const [, projectKey, login, rest] = match;

    const owner = (await db.query(
      `select u.id, u.login from app_user u join membership m on m.user_id = u.id
       where m.project_id = $1 and lower(u.login) = lower($2) and m.role in ('admin', 'developer')`,
      [projectKey, login],
    )).rows[0];
    if (!owner) throw notFound();

    const who = await resolveActor(req);
    let actor = null;
    if (who) {
      const member = (await db.query('select role from membership where project_id = $1 and user_id = $2', [projectKey, who.id])).rows[0];
      actor = { id: who.id, login: who.login, role: member?.role ?? null };
    }
    if (!authorize(actor, ACTIONS.READ)) throw notFound();

    if (!rest) {
      // Relative URLs resolve against the last slash. Built from the checked parts, never from what was sent.
      res.writeHead(308, baseHeaders({ Location: `/p/${projectKey}/u/${owner.login}/` }));
      return res.end();
    }
    const handler = await handlerFor(projectKey, owner.id);
    return handler.handle(req, res, { path: rest, url, actor });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => sendError(res, error));
  });

  return {
    server,
    listen: ({ host, port }) => new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeAllListeners('error'); resolveListen(server.address().port); });
    }),
    /** A write made in this process (a push, once it arrives over HTTP): tell the open pages without waiting for the poll. */
    async notify(projectId) {
      for (const [key, slot] of mounted) if (key.startsWith(`${projectId}:`)) (await slot.ready).notify();
    },
    async close() {
      clearInterval(sweeper);
      for (const slot of mounted.values()) (await slot.ready.catch(() => null))?.close();
      mounted.clear();
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}
