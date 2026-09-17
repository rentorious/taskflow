// Materialise a synthetic taskflow cycle on disk.
//
// Fixtures are code rather than committed directories because two things the
// report depends on cannot live in git: empty `<batch>.lock/` directories, and
// file ages (a lock's age decides whether a claim is starting up or stale).
//
// Everything here is invented. This repository is public: never paste real
// task titles, provider ids, client names or pull request URLs into a fixture.

import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>window.pwned = true</script><rect width="40" height="40" fill="#888"/></svg>';

/**
 * @param {object} spec  see test/fixtures/specs.mjs
 * @param {string} dir   target directory (created if missing)
 * @param {number} [now] reference time for relative ages
 */
export async function materialize(spec, dir, now = Date.now()) {
  await mkdir(join(dir, 'batches'), { recursive: true });
  await mkdir(join(dir, 'tasks'), { recursive: true });

  const indexFile = spec.indexFile ?? `state.${spec.slug}.json`;
  if (spec.index) await writeFile(join(dir, indexFile), JSON.stringify(spec.index, null, 2));

  for (const [key, body] of Object.entries(spec.batchFiles ?? {})) {
    const path = join(dir, 'batches', `${key}.json`);
    await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    const ageMs = spec.batchFileAges?.[key];
    if (ageMs !== undefined) await utimes(path, new Date(now - ageMs), new Date(now - ageMs));
  }

  for (const [key, ageMs] of Object.entries(spec.locks ?? {})) {
    const path = join(dir, 'batches', `${key}.lock`);
    await mkdir(path, { recursive: true });
    await utimes(path, new Date(now - ageMs), new Date(now - ageMs));
  }

  for (const [id, markdown] of Object.entries(spec.plans ?? {})) await writeFile(join(dir, 'tasks', `${id}.md`), markdown);

  for (const [id, files] of Object.entries(spec.attachments ?? {})) {
    await mkdir(join(dir, 'attachments', id), { recursive: true });
    for (const name of files) await writeFile(join(dir, 'attachments', id, name), name.endsWith('.svg') ? HOSTILE_SVG : PNG);
  }

  if (spec.summary) await writeFile(join(dir, spec.summary.name), spec.summary.markdown);
  if (spec.ticks) await writeFile(join(dir, `report-inbox.${spec.slug}.json`), JSON.stringify(spec.ticks, null, 2));

  for (const [name, archived] of Object.entries(spec.archives ?? {})) await materialize(archived, join(dir, 'archive', name), now);
  return dir;
}

export async function materializeTemp(spec, now = Date.now()) {
  return materialize(spec, await mkdtemp(join(tmpdir(), 'taskflow-fixture-')), now);
}
