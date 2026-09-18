#!/usr/bin/env node
// Development tool: put a cycle directory into the database, the way `taskflow push`
// will over HTTP. Same payload builder, same ingest, same blobs; only the transport
// and the sign-in are missing.
//
//   DATABASE_URL=postgres://... node server/dev/seed.mjs --dir <output_dir> --project <key> --user <login>
//                                                        [--import-answers] [--no-enrich]
//
// It creates the project and the user when they are not there yet. It writes one
// file into <output_dir>: cycle.<slug>.json, the cycle's id.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureCycleId } from '../../scripts/report/cycle-id.mjs';
import { buildPayload } from '../../scripts/report/payload.mjs';
import { createReader, findProject } from '../../scripts/report/read.mjs';
import { tickFileName } from '../../scripts/report/ticks.mjs';
import { createDb } from '../db.mjs';
import { importLocalHumanState } from '../import-local.mjs';
import { ingestCycle, putBlob } from '../ingest.mjs';
import { migrate } from '../migrate.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const stop = (message) => { console.error(message); process.exit(1); };
const readJson = (path) => readFile(path, 'utf8').then(JSON.parse).catch(() => null);

const dir = option('--dir') ? resolve(option('--dir')) : null;
const project = option('--project');
const login = option('--user');
if (!dir || !project || !login) stop('Usage: seed.mjs --dir <output_dir> --project <key> --user <login> [--import-answers] [--no-enrich]');
if (!existsSync(dir)) stop(`Directory not found: ${dir}`);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.');

const db = createDb(process.env.DATABASE_URL);
try {
  await migrate(db);

  const found = findProject(dir);
  const raw = await createReader(dir, { config: found.config }).read();
  if (!raw.index) stop(`No triage state in ${dir}.`);
  const cycleId = await ensureCycleId(dir, raw.cycle.slug);

  let enrichment = null;
  if (!flag('--no-enrich')) {
    const { createEnricher } = await import('../../scripts/report/enrich.mjs');
    const enricher = createEnricher();
    enricher.snapshot(raw, found.root); // schedules the lookups
    await enricher.settle();
    enrichment = enricher.snapshot(raw, found.root);
    enricher.close();
  }

  const { payload, blobs } = await buildPayload({ raw, cycleId, enrichment, host: hostname(), pluginVersion: 'seed' });

  await db.query('insert into project (id, name) values ($1, $2) on conflict (id) do nothing', [project, found.config?.projectName ?? project]);
  const user = (await db.query(
    `with existing as (select id from app_user where lower(login) = lower($1)),
          created as (insert into app_user (login, name) select $1, $1 where not exists (select 1 from existing) returning id)
     select id from existing union all select id from created`, [login])).rows[0];
  await db.query("insert into membership (project_id, user_id, role) values ($1, $2, 'developer') on conflict do nothing", [project, user.id]);

  const result = await ingestCycle(db, { projectId: project, userId: user.id, payload });
  for (const hash of result.missing) await putBlob(db, { projectId: project, sha256: hash, body: await blobs.get(hash).read() });
  console.log(`${result.changed ? 'Pushed' : 'Unchanged'}: cycle ${result.cycleUuid}, ${result.missing.length} of ${blobs.size} blobs uploaded${result.archived ? `, previous cycle archived as ${result.archived}` : ''}.`);

  if (flag('--import-answers')) {
    const report = await importLocalHumanState(db, {
      projectId: project, userId: user.id, cycleUuid: result.cycleUuid,
      answersJson: await readJson(join(dir, 'answers.json')),
      ticksJson: await readJson(join(dir, tickFileName(raw.cycle.slug))),
    });
    console.log(`Imported ${report.questions.imported} questions with ${report.answers} answers and ${report.ticks.imported} ticks; skipped ${report.questions.skipped.length} questions.`);
    for (const skipped of report.questions.skipped) console.log(`  skipped ${skipped.id}: ${skipped.reason}`);
  }
  console.log(`Open: <PUBLIC_URL>/p/${project}/u/${login}/`);
} catch (error) {
  console.error(error.status ? `Refused (${error.status}): ${error.message}` : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
