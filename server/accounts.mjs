// People, projects and who belongs where. Every rule about membership lives here;
// the HTTP layer only decides who is asking (auth.mjs) and whether they may (authorize.mjs).
//
// A user row exists only for someone who was let in: a configured admin, an invited
// login, or a member. A stranger who signs in with GitHub leaves no row behind.

import { createHash, randomBytes } from 'node:crypto';

export const ROLES = ['admin', 'developer', 'answerer'];
const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{1,38}$/;
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/;
const INVITE_DAYS = 30;
const MAX_TOKENS_PER_USER = 20;
export const TOKEN_PREFIX = 'tfp_';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const hashSecret = (value) => createHash('sha256').update(value).digest('hex');

const asUser = (row) => (row ? { id: String(row.id), login: row.login, name: row.name ?? null, avatarUrl: row.avatar_url ?? null, isInstanceAdmin: row.is_instance_admin === true } : null);

export function createAccounts(db, { admins = [] } = {}) {
  const adminLogins = new Set(admins.map((login) => login.toLowerCase()));

  const audit = (q, userId, projectId, action, payload = {}) =>
    q.query('insert into audit_log (user_id, project_id, action, payload) values ($1, $2, $3, $4)', [userId, projectId, action, JSON.stringify(payload)]);

  async function userById(id) {
    return asUser((await db.query('select * from app_user where id = $1', [id])).rows[0]);
  }

  /**
   * After GitHub has vouched for a profile: find or create the user, or refuse.
   * @param {{id: number, login: string, name?: string|null, avatar_url?: string|null}} profile
   * @returns {Promise<{user: object}|{refused: true, login: string}>}
   */
  function signIn(profile) {
    const login = String(profile.login);
    const lower = login.toLowerCase();
    if (!Number.isSafeInteger(profile.id) || !LOGIN.test(lower)) throw fail(502, 'GitHub sent a profile this server cannot use.');

    return db.tx(async (q) => {
      let row = (await q.query('select * from app_user where github_id = $1 for update', [profile.id])).rows[0];

      if (!row) {
        const isAdmin = adminLogins.has(lower);
        const invited = (await q.query(`select 1 from invite where github_login = $1 and created_at > now() - interval '${INVITE_DAYS} days' limit 1`, [lower])).rowCount > 0;
        // A row made before this person ever signed in (the seed tool makes them). The login is all that ties it to them.
        const placeholder = (await q.query('select id from app_user where lower(login) = $1 and github_id is null for update', [lower])).rows[0];
        if (!isAdmin && !invited && !placeholder) {
          await audit(q, null, null, 'signin.refused', { login });
          return { refused: true, login };
        }
        row = placeholder
          ? (await q.query('update app_user set github_id = $1 where id = $2 returning *', [profile.id, placeholder.id])).rows[0]
          : null;
      }

      // Logins can be renamed and re-registered. Whoever GitHub says holds it now, holds it; an older row steps aside.
      await q.query("update app_user set login = 'gone-' || id where lower(login) = $1 and github_id is distinct from $2", [lower, profile.id]);

      const fields = [login, profile.name ?? null, profile.avatar_url ?? null, adminLogins.has(lower)];
      row = row
        ? (await q.query('update app_user set login = $2, name = $3, avatar_url = $4, is_instance_admin = is_instance_admin or $5, last_seen_at = now() where id = $1 returning *', [row.id, ...fields])).rows[0]
        : (await q.query('insert into app_user (github_id, login, name, avatar_url, is_instance_admin, last_seen_at) values ($1, $2, $3, $4, $5, now()) returning *', [profile.id, ...fields])).rows[0];

      const invites = (await q.query(`delete from invite where github_login = $1 and created_at > now() - interval '${INVITE_DAYS} days' returning project_id, role`, [lower])).rows;
      for (const invite of invites) {
        await q.query('insert into membership (project_id, user_id, role) values ($1, $2, $3) on conflict do nothing', [invite.project_id, row.id, invite.role]);
        await audit(q, row.id, invite.project_id, 'invite.accepted', { role: invite.role });
      }

      // Let in earlier, but with nothing left to see: no session for them either.
      if (!row.is_instance_admin && !(await q.query('select 1 from membership where user_id = $1 limit 1', [row.id])).rowCount) {
        await audit(q, row.id, null, 'signin.refused', { login, reason: 'no membership' });
        return { refused: true, login };
      }
      await audit(q, row.id, null, 'signin', {});
      return { user: asUser(row) };
    });
  }

  /** Every project the user belongs to, with the developers whose cycles can be opened. */
  async function projectsFor(user) {
    const { rows } = await db.query(
      `select p.id, p.name, m.role,
              coalesce((select json_agg(json_build_object('login', u.login, 'pushedAt', c.pushed_at) order by u.login)
                        from cycle c join app_user u on u.id = c.user_id where c.project_id = p.id and c.is_live), '[]'::json) as cycles
       from project p join membership m on m.project_id = p.id and m.user_id = $1 order by p.name`,
      [user.id],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, cycles: r.cycles }));
  }

  async function roleIn(projectId, userId) {
    return (await db.query('select role from membership where project_id = $1 and user_id = $2', [projectId, userId])).rows[0]?.role ?? null;
  }

  function createProject(actor, { id, name }) {
    const key = String(id ?? '').trim().toLowerCase();
    const label = String(name ?? '').trim() || key;
    if (!PROJECT_KEY.test(key)) throw fail(400, 'A project key is 2 to 39 characters: lower-case letters, digits and hyphens.');
    if (label.length > 200) throw fail(400, 'The project name is too long.');
    return db.tx(async (q) => {
      const made = await q.query('insert into project (id, name, created_by) values ($1, $2, $3) on conflict do nothing', [key, label, actor.id]);
      if (!made.rowCount) throw fail(409, 'That project key is taken.');
      await q.query("insert into membership (project_id, user_id, role) values ($1, $2, 'admin')", [key, actor.id]);
      await audit(q, actor.id, key, 'project.created', { name: label });
      return { id: key, name: label };
    });
  }

  async function members(projectId) {
    const people = await db.query('select u.id, u.login, u.name, m.role from membership m join app_user u on u.id = m.user_id where m.project_id = $1 order by lower(u.login)', [projectId]);
    const invites = await db.query(`select github_login as login, role, created_at > now() - interval '${INVITE_DAYS} days' as valid from invite where project_id = $1 order by github_login`, [projectId]);
    return { members: people.rows.map((r) => ({ id: String(r.id), login: r.login, name: r.name, role: r.role })), invites: invites.rows };
  }

  /** Someone who has signed in before joins at once; anyone else gets an invite that their first sign-in consumes. */
  function invite(actor, projectId, { login, role }) {
    const lower = String(login ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!LOGIN.test(lower)) throw fail(400, 'That is not a GitHub login.');
    if (!ROLES.includes(role)) throw fail(400, `A role is one of: ${ROLES.join(', ')}.`);
    return db.tx(async (q) => {
      const known = (await q.query('select id from app_user where lower(login) = $1 and github_id is not null', [lower])).rows[0];
      if (known) {
        await q.query('insert into membership (project_id, user_id, role) values ($1, $2, $3) on conflict (project_id, user_id) do update set role = excluded.role', [projectId, known.id, role]);
      } else {
        await q.query('insert into invite (project_id, github_login, role, invited_by) values ($1, $2, $3, $4) on conflict (project_id, github_login) do update set role = excluded.role, created_at = now(), invited_by = excluded.invited_by', [projectId, lower, role, actor.id]);
      }
      await audit(q, actor.id, projectId, known ? 'member.added' : 'invite.created', { login: lower, role });
      return { joined: Boolean(known) };
    });
  }

  function removeInvite(actor, projectId, login) {
    return db.tx(async (q) => {
      await q.query('delete from invite where project_id = $1 and github_login = $2', [projectId, String(login ?? '').toLowerCase()]);
      await audit(q, actor.id, projectId, 'invite.removed', { login });
    });
  }

  /** A project keeps at least one admin, or nobody could ever manage it again. */
  async function keepAnAdmin(q, projectId, exceptUserId) {
    const others = await q.query("select 1 from membership where project_id = $1 and role = 'admin' and user_id <> $2 limit 1", [projectId, exceptUserId]);
    if (!others.rowCount) throw fail(409, 'A project needs at least one admin. Make someone else an admin first.');
  }

  function setRole(actor, projectId, userId, role) {
    if (!ROLES.includes(role)) throw fail(400, `A role is one of: ${ROLES.join(', ')}.`);
    return db.tx(async (q) => {
      const current = (await q.query('select role from membership where project_id = $1 and user_id = $2 for update', [projectId, userId])).rows[0];
      if (!current) throw fail(404, 'No such member.');
      if (current.role === 'admin' && role !== 'admin') await keepAnAdmin(q, projectId, userId);
      await q.query('update membership set role = $3 where project_id = $1 and user_id = $2', [projectId, userId, role]);
      await audit(q, actor.id, projectId, 'member.role', { user: String(userId), role });
    });
  }

  function removeMember(actor, projectId, userId) {
    return db.tx(async (q) => {
      const current = (await q.query('select role from membership where project_id = $1 and user_id = $2 for update', [projectId, userId])).rows[0];
      if (!current) throw fail(404, 'No such member.');
      if (current.role === 'admin') await keepAnAdmin(q, projectId, userId);
      await q.query('delete from membership where project_id = $1 and user_id = $2', [projectId, userId]);
      // Access is checked per request, so leaving one project cuts it off at once. With no project
      // left, nothing this person holds should keep working either.
      const left = await q.query('select 1 from membership where user_id = $1 limit 1', [userId]);
      const admin = await q.query('select 1 from app_user where id = $1 and is_instance_admin', [userId]);
      if (!left.rowCount && !admin.rowCount) {
        await q.query('delete from session where user_id = $1', [userId]);
        await q.query('update api_token set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
      }
      await audit(q, actor.id, projectId, 'member.removed', { user: String(userId) });
    });
  }

  // -- CLI tokens -------------------------------------------------------------------

  async function tokens(user) {
    const { rows } = await db.query('select id, label, created_at, last_used_at from api_token where user_id = $1 and revoked_at is null order by id', [user.id]);
    return rows.map((r) => ({ id: String(r.id), label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  /** @returns {Promise<{id: string, token: string}>} the token itself is shown once and never stored */
  function createToken(user, label) {
    const clean = String(label ?? '').trim().slice(0, 100) || 'CLI';
    return db.tx(async (q) => {
      const held = await q.query('select count(*)::int as n from api_token where user_id = $1 and revoked_at is null', [user.id]);
      if (held.rows[0].n >= MAX_TOKENS_PER_USER) throw fail(409, `You hold ${MAX_TOKENS_PER_USER} tokens already. Revoke one first.`);
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const made = await q.query('insert into api_token (user_id, token_hash, label) values ($1, $2, $3) returning id', [user.id, hashSecret(token), clean]);
      await audit(q, user.id, null, 'token.created', { token: String(made.rows[0].id), label: clean });
      return { id: String(made.rows[0].id), token };
    });
  }

  function revokeToken(user, id) {
    return db.tx(async (q) => {
      const done = await q.query('update api_token set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null', [id, user.id]);
      if (!done.rowCount) throw fail(404, 'No such token.');
      await audit(q, user.id, null, 'token.revoked', { token: String(id) });
    });
  }

  /** @returns {Promise<object|null>} the user a presented token belongs to */
  async function userByToken(token) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const row = (await db.query(
      `update api_token t set last_used_at = now() from app_user u
       where t.token_hash = $1 and t.revoked_at is null and u.id = t.user_id returning u.*`, [hashSecret(token)])).rows[0];
    return asUser(row);
  }

  return { userById, signIn, projectsFor, roleIn, createProject, members, invite, removeInvite, setRole, removeMember, tokens, createToken, revokeToken, userByToken };
}
