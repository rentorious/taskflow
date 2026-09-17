import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../scripts/report/server.mjs';
import { writeSnapshot } from '../scripts/report/snapshot.mjs';
import { specs } from './fixtures/specs.mjs';
import { materializeTemp } from './helpers/cycle.mjs';

test('a snapshot is one self-contained file that cannot be broken out of', async () => {
  const dir = await materializeTemp(specs['kitchen-sink']);
  const app = await createApp({ dir, version: 'test' });
  try {
    const out = await writeSnapshot(app, { outFile: join(dir, 'snapshot.html') });
    assert.equal(out.outsideCycle, false);
    const html = await readFile(out.path, 'utf8');

    assert.ok(!/<link[^>]+stylesheet/.test(html), 'styles are inlined');
    assert.ok(!/<script[^>]+src=/.test(html), 'scripts are inlined');
    assert.ok(!html.includes("url('fonts/"), 'fonts are inlined');
    assert.match(html, /data:font\/woff2;base64,/);

    const block = /<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(block, 'embedded data block');
    assert.ok(!block[1].includes('<'), 'no raw "<" inside the JSON block, so hostile plan text cannot close it');
    const data = JSON.parse(block[1]);
    assert.equal(data.model.counts.batches, 17);
    assert.ok(data.tasks.hb101.sections.length > 3);
    assert.match(data.summary.html, /Triage summary/);

    // Exactly the three scripts we wrote: theme, data, app.
    assert.equal(html.match(/<script\b/g).length, 3);

    const elsewhere = await writeSnapshot(app, { outFile: join(dir, 'batches', 'snapshot.html') });
    assert.equal(elsewhere.outsideCycle, true);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
