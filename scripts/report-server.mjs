#!/usr/bin/env node
// Taskflow report server — CLI entry. The work lives in ./report/.
//
//   node report-server.mjs --dir <output_dir> [--port 3847] [--dev-slug <slug>]
//                          [--project <root>] [--no-pidfile] [--no-enrich]
//   node report-server.mjs --dir <output_dir> --print-model [--cycle <id>]
//   node report-server.mjs --dir <output_dir> --snapshot <out.html> [--cycle <id>]

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`The report server needs Node 18.17 or newer. This is ${process.versions.node}.`);
  process.exit(1);
}

const { createApp } = await import('./report/server.mjs');

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = resolve(dirname(scriptPath), '..');
const DEFAULT_PORT = 3847;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
function option(name, fallback = null) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? 'dev';
  } catch {
    return 'dev';
  }
}

const dirArg = option('--dir');
if (!dirArg) {
  console.error('Usage: report-server.mjs --dir <output_dir> [--port 3847] [--dev-slug <slug>] [--project <root>] [--no-pidfile] [--no-enrich] [--print-model | --snapshot <out.html>] [--cycle <id>]');
  process.exit(1);
}
const dir = resolve(dirArg);
if (!existsSync(dir)) {
  console.error(`Directory not found: ${dir}`);
  process.exit(1);
}

const port = Number.parseInt(option('--port', String(DEFAULT_PORT)), 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Not a valid port: ${option('--port')}`);
  process.exit(1);
}

let enrich = null;
if (!flag('--no-enrich')) {
  // Optional: the enrichment module may not exist in a partial checkout.
  enrich = await import('./report/enrich.mjs').then((m) => m.createEnricher()).catch(() => null);
}

const app = await createApp({ dir, slug: option('--dev-slug'), project: option('--project'), version: pluginVersion(), enrich, scriptPath });

// -- one-shot modes -------------------------------------------------------------

if (flag('--print-model')) {
  let { model } = await app.getState(option('--cycle', 'live'));
  if (enrich) {
    // Pull request states arrive in the background; wait for them once.
    await enrich.settle();
    ({ model } = await app.getState(option('--cycle', 'live'), { force: true }));
  }
  await app.close();
  enrich?.close();
  // Exit only once the pipe has drained: process.exit() drops whatever is still
  // buffered, which truncates the JSON at the 64 KB pipe size.
  await new Promise((done) => process.stdout.write(`${JSON.stringify(model, null, 2)}\n`, done));
  process.exit(0);
}

if (option('--snapshot')) {
  const { writeSnapshot } = await import('./report/snapshot.mjs');
  const out = await writeSnapshot(app, { cycle: option('--cycle', 'live'), outFile: resolve(option('--snapshot')) });
  console.log(`Snapshot written to ${out.path}`);
  if (out.outsideCycle) console.error('Warning: the snapshot embeds ticket text and sits outside the taskflow output directory. Screenshots will not load from there.');
  await app.close();
  process.exit(0);
}

// -- serve ----------------------------------------------------------------------

const pidPath = join(dir, '.report-server.pid');
const infoPath = join(dir, '.report-server.json');
const usePidFile = !flag('--no-pidfile');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

if (usePidFile && existsSync(pidPath)) {
  const owner = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
  if (owner && owner !== process.pid && alive(owner)) {
    let where = '';
    try { where = ` at ${JSON.parse(readFileSync(infoPath, 'utf8')).url}`; } catch { /* started by an older version */ }
    console.error(`A report server (pid ${owner}) already owns ${dir}${where}. Stop it first, or pass --no-pidfile for a second, unregistered server.`);
    await app.close();
    process.exit(2);
  }
}

const boundPort = await app.listen(port);
const url = `http://127.0.0.1:${boundPort}`;

if (usePidFile) {
  writeFileSync(pidPath, String(process.pid));
  writeFileSync(infoPath, `${JSON.stringify({ pid: process.pid, port: boundPort, url, version: pluginVersion(), scriptPath, startedAt: new Date().toISOString() }, null, 2)}\n`);
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (usePidFile) {
    // Only remove files that still name this process: a newer server may have
    // taken over the directory since we started.
    try { if (Number.parseInt(readFileSync(pidPath, 'utf8'), 10) === process.pid) unlinkSync(pidPath); } catch { /* already gone */ }
    try { if (JSON.parse(readFileSync(infoPath, 'utf8')).pid === process.pid) unlinkSync(infoPath); } catch { /* already gone */ }
  }
  enrich?.close?.();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (boundPort !== port && port !== 0) console.log(`Port ${port} is taken; using ${boundPort}.`);
console.log(`Taskflow report: ${url}`);
