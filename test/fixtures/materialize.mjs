#!/usr/bin/env node
// Write a synthetic cycle to disk so the report server can be pointed at it:
//
//   node test/fixtures/materialize.mjs kitchen-sink /tmp/taskflow-ks
//   node scripts/report-server.mjs --dir /tmp/taskflow-ks --port 3848 --no-pidfile

import { readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { materialize } from '../helpers/cycle.mjs';
import { specs } from './specs.mjs';

const MARKER = '.taskflow-fixture';

const [name, target] = process.argv.slice(2);
if (!specs[name] || !target) {
  console.error(`Usage: materialize.mjs <${Object.keys(specs).join('|')}> <new-or-empty-directory>`);
  process.exit(1);
}

const dir = resolve(target);
const existing = await readdir(dir).catch(() => []);

// The target is replaced wholesale, so only ever replace a directory this
// script made. Anything else must be new or empty.
if (existing.length > 0 && !existing.includes(MARKER)) {
  console.error(`Refusing to overwrite ${dir}: it is not empty and was not created by this script.`);
  process.exit(1);
}

await rm(dir, { recursive: true, force: true });
await materialize(specs[name], dir);
await writeFile(join(dir, MARKER), `${name}\n`);
console.log(dir);
