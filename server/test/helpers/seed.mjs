// Rows every server test needs before it can start: a project, people in it, and
// sometimes a cycle for ticks to hang on.

import { randomUUID } from 'node:crypto';

export async function seedUser(db, projectId, { login, role = 'developer' }) {
  const { rows } = await db.query('insert into app_user (login, name) values ($1, $1) returning id', [login]);
  await db.query('insert into membership (project_id, user_id, role) values ($1, $2, $3)', [projectId, rows[0].id, role]);
  return { id: rows[0].id, login, role };
}

export async function seedProject(db, { project = 'demo', login = 'sam', role = 'developer' } = {}) {
  await db.query('insert into project (id, name) values ($1, $2)', [project, `Project ${project}`]);
  return { projectId: project, user: await seedUser(db, project, { login, role }) };
}

/** The least a cycle row can be. Real ones come from ingest. */
export async function bareCycle(db, { projectId, userId, id = randomUUID() }) {
  await db.query("insert into cycle (id, project_id, user_id, is_live, snapshot, payload_sha256) values ($1, $2, $3, true, '{}', 'none')", [id, projectId, userId]);
  return id;
}
