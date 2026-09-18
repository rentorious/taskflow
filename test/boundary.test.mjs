// The plugin installs by copying files: nothing under scripts/ may need an
// install step. The hosted server lives in server/ and is the only place a
// package may be imported.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECIFIER = /(?:^|[\s;])import\s*(?:[\w*${}\s,]+?\s+from\s*)?['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]/gm;

async function sources(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.(mjs|js)$/.test(entry.name)) found.push(path);
  }
  return found;
}

export function specifiersOf(source) {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2]);
}

test('the matcher sees static, bare and dynamic imports', () => {
  const sample = [
    "import a from 'node:fs';",
    "import { b,\n  c } from './b.mjs';",
    "import 'side-effect';",
    "const d = await import('../d.mjs');",
    "const text = 'import x from \"not-code\"';",
  ].join('\n');
  assert.deepEqual(specifiersOf(sample).slice(0, 4), ['node:fs', './b.mjs', 'side-effect', '../d.mjs']);
});

test('everything under scripts/ imports only node: built-ins and relative files', async () => {
  const offenders = [];
  for (const file of await sources(join(ROOT, 'scripts'))) {
    for (const specifier of specifiersOf(await readFile(file, 'utf8'))) {
      if (specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')) continue;
      offenders.push(`${relative(ROOT, file)} imports "${specifier}"`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('nothing under scripts/ reaches into server/', async () => {
  const offenders = [];
  for (const file of await sources(join(ROOT, 'scripts'))) {
    for (const specifier of specifiersOf(await readFile(file, 'utf8'))) {
      // A path segment named server/, not the report's own server.mjs.
      if (/(^|\/)server\//.test(specifier)) offenders.push(`${relative(ROOT, file)} imports "${specifier}"`);
    }
  }
  assert.deepEqual(offenders, []);
});
