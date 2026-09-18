// Who is asking: GitHub sign-in for browsers, bearer tokens for the CLI.
//
// GitHub is asked for no scope at all. A token without scopes already returns the
// id, login, name and avatar, which is everything this server reads, and then it
// is thrown away: nothing of GitHub's is stored.
//
// A browser session is a random value in a cookie; the database holds its hash.
// The round trip to GitHub is protected by `state` and by PKCE, both carried in a
// short-lived cookie signed with SESSION_SECRET, so no table is written for
// visitors who have not signed in.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashSecret } from './accounts.mjs';

export const SESSION_COOKIE = 'tf_session';
const OAUTH_COOKIE = 'tf_oauth';
const SESSION_DAYS = 30;
const ROLL_AFTER_MS = 60 * 60 * 1000;
const OAUTH_TTL_S = 10 * 60;
const NEXT = /^\/(p\/[a-z0-9-]{2,39}\/u\/[A-Za-z0-9-]{1,39}\/|settings)?$/;

export const GITHUB = Object.freeze({
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userUrl: 'https://api.github.com/user',
});

const b64 = (buffer) => Buffer.from(buffer).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Where to go after sign-in: only ever a place on this site that this server knows. */
export function safeNext(value) {
  return typeof value === 'string' && value.length <= 200 && NEXT.test(value) ? value : '/';
}

/**
 * @param {object} options
 * @param {object} options.db
 * @param {object} options.accounts   from accounts.mjs
 * @param {URL} options.publicUrl
 * @param {{clientId: string, clientSecret: string, sessionSecret: string, secureCookies: boolean}} options.config
 * @param {object} [options.github]   endpoints; tests point these at a stand-in
 */
export function createAuth({ db, accounts, publicUrl, config, github = GITHUB, fetchImpl = fetch, now = () => Date.now() }) {
  const redirectUri = new URL('/auth/callback', publicUrl).href;
  const cookie = (name, value, { maxAge, path = '/' }) =>
    `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${config.secureCookies ? '; Secure' : ''}`;
  const sign = (payload) => b64(createHmac('sha256', config.sessionSecret).update(payload).digest());

  function addCookie(res, value) {
    const held = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(held) ? held : held ? [held] : []), value]);
  }

  /** GET /auth/github */
  function start(req, res, url) {
    const state = b64(randomBytes(24));
    const verifier = b64(randomBytes(32)); // 43 characters, as PKCE wants
    const payload = b64(JSON.stringify({ state, verifier, next: safeNext(url.searchParams.get('next')), exp: Math.floor(now() / 1000) + OAUTH_TTL_S }));
    addCookie(res, cookie(OAUTH_COOKIE, `${payload}.${sign(payload)}`, { maxAge: OAUTH_TTL_S, path: '/auth' }));

    const target = new URL(github.authorizeUrl);
    target.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: b64(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      allow_signup: 'false',
    }).toString();
    res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store' });
    res.end();
  }

  function readOauthCookie(req) {
    const raw = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
    if (!raw) return null;
    const [payload, signature] = raw.split('.');
    if (!payload || !signature || !same(signature, sign(payload))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.exp > now() / 1000 ? data : null;
    } catch {
      return null;
    }
  }

  async function githubProfile(code, verifier) {
    const exchange = await fetchImpl(github.tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'taskflow' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
      signal: AbortSignal.timeout(10000),
    });
    const token = exchange.ok ? (await exchange.json().catch(() => ({}))).access_token : null;
    if (!token) return null;
    const profile = await fetchImpl(github.userUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'taskflow' },
      signal: AbortSignal.timeout(10000),
    });
    return profile.ok ? profile.json() : null;
  }

  /**
   * GET /auth/callback
   * @returns {Promise<{ok: true, next: string}|{ok: false, reason: 'bad-request'|'github'|'not-invited', login?: string}>}
   */
  async function callback(req, res, url) {
    const held = readOauthCookie(req);
    addCookie(res, cookie(OAUTH_COOKIE, '', { maxAge: 0, path: '/auth' })); // single use, whatever happens next
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!held || !code || !state || !same(state, held.state)) return { ok: false, reason: 'bad-request' };

    const profile = await githubProfile(code, held.verifier).catch(() => null);
    if (!profile) return { ok: false, reason: 'github' };

    const result = await accounts.signIn(profile);
    if (result.refused) return { ok: false, reason: 'not-invited', login: result.login };

    const id = b64(randomBytes(32));
    await db.query(`insert into session (id_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`, [hashSecret(id), result.user.id]);
    addCookie(res, cookie(SESSION_COOKIE, id, { maxAge: SESSION_DAYS * 86400 }));
    return { ok: true, next: held.next };
  }

  /** POST /auth/logout */
  async function logout(req, res) {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (id) await db.query('delete from session where id_hash = $1', [hashSecret(id)]);
    addCookie(res, cookie(SESSION_COOKIE, '', { maxAge: 0 }));
  }

  /**
   * @returns {Promise<{actor: object|null, badToken: boolean}>}
   *   `actor.via` is "session" or "token". A token that is presented and wrong is not the same as no token.
   */
  async function resolve(req, res) {
    const header = req.headers.authorization;
    if (header) {
      const user = /^Bearer\s+(\S+)$/i.test(header) ? await accounts.userByToken(header.replace(/^Bearer\s+/i, '')) : null;
      return user ? { actor: { ...user, via: 'token' }, badToken: false } : { actor: null, badToken: true };
    }

    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id) return { actor: null, badToken: false };
    const row = (await db.query(
      `select u.*, s.last_seen_at as session_seen_at from session s join app_user u on u.id = s.user_id where s.id_hash = $1 and s.expires_at > now()`, [hashSecret(id)])).rows[0];
    if (!row) return { actor: null, badToken: false };

    // Rolling: a session in use keeps its thirty days. Written at most once an hour.
    if (now() - new Date(row.session_seen_at).getTime() > ROLL_AFTER_MS) {
      await db.query(`update session set last_seen_at = now(), expires_at = now() + interval '${SESSION_DAYS} days' where id_hash = $1`, [hashSecret(id)]);
      addCookie(res, cookie(SESSION_COOKIE, id, { maxAge: SESSION_DAYS * 86400 }));
    }
    return { actor: { id: String(row.id), login: row.login, name: row.name ?? null, avatarUrl: row.avatar_url ?? null, isInstanceAdmin: row.is_instance_admin === true, via: 'session' }, badToken: false };
  }

  return { start, callback, logout, resolve };
}

/** How many times something went wrong from one address, lately. In memory: one process serves one team. */
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const seen = new Map();
  const live = (key) => {
    const entry = seen.get(key);
    if (entry && now() - entry.since < windowMs) return entry;
    seen.delete(key);
    return null;
  };
  return {
    blocked: (key) => (live(key)?.count ?? 0) >= max,
    fail(key) {
      const entry = live(key) ?? { since: now(), count: 0 };
      entry.count++;
      seen.set(key, entry);
      if (seen.size > 10000) for (const old of seen.keys()) { if (!live(old)) seen.delete(old); }
    },
  };
}
