// A hosted project's answers live on its server. The local report still shows the
// pipeline, but it must not take answers nobody will read.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findProject } from '../scripts/report/read.mjs';
import { createApp } from '../scripts/report/server.mjs';
import { questions } from './fixtures/specs.mjs';
import { materialize } from './helpers/cycle.mjs';

async function project(server) {
  const root = await mkdtemp(join(tmpdir(), 'taskflow-hosted-local-'));
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude', 'taskflow-config.json'), JSON.stringify({ project_name: 'Harbor Books', output_dir: 'out', ...(server ? { server } : {}) }));
  await materialize(questions, join(root, 'out'));
  return root;
}

test('hosted: the local page is read-only, says where to go, and refuses writes itself', async () => {
  const root = await project({ url: 'https://flow.example.com/', project: 'harbor' });
  const app = await createApp({ dir: join(root, 'out'), version: 'test' });
  try {
    const port = await app.listen(0);
    const model = await (await fetch(`http://127.0.0.1:${port}/api/model`)).json();
    assert.equal(model.cycle.readOnly, true);
    assert.match(model.health.problems.find((p) => p.code === 'hosted-elsewhere').message, /https:\/\/flow\.example\.com\//);
    const item = model.inbox['question:qs101:q-cover-ratio'];
    const res = await fetch(`http://127.0.0.1:${port}/api/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, fingerprint: item.fingerprint, body: 'Square.' }) });
    assert.equal(res.status, 403);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a server block that would send a token in the clear, or names no project, does not count as hosted', async () => {
  for (const server of [{ url: 'http://flow.example.com', project: 'harbor' }, { url: 'https://flow.example.com', project: 'Not A Key' }, { url: 'nonsense', project: 'harbor' }, 'https://flow.example.com']) {
    const root = await project(server);
    try {
      assert.equal(findProject(join(root, 'out')).server, null, JSON.stringify(server));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const root = await project({ url: 'http://127.0.0.1:3900', project: 'harbor' });
  assert.deepEqual(findProject(join(root, 'out')).server, { url: 'http://127.0.0.1:3900', project: 'harbor' }, 'loopback is fine: development');
  await rm(root, { recursive: true, force: true });
});
