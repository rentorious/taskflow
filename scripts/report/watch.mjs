// Change detection for a cycle directory.
//
// The source of truth is a cheap signature poll (a few dozen stat calls). On
// Linux, fs.watch can fail *silently*: on network and some bind mounts, and
// after /taskflow:clean moves the directory an inotify watch keeps following the
// old inode. "Fall back on error" never fires in those cases, so fs.watch is
// used only to shorten latency, never as the thing we trust.

import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const WATCHED_SUBDIRS = ['', 'batches', 'tasks', 'attachments'];
const DEBOUNCE_MS = 150;

/** A hash of names, sizes and mtimes. Lock directories count: claiming a batch is a `mkdir`. */
export async function computeSignature(dir) {
  const hash = createHash('sha1');
  for (const sub of WATCHED_SUBDIRS) {
    const base = join(dir, sub);
    let names = [];
    try {
      names = (await readdir(base)).sort();
    } catch {
      hash.update(`${sub}:missing\n`);
      continue;
    }
    for (const name of names) {
      if (sub === '' && (name === 'archive' || name.startsWith('.report-server'))) continue;
      try {
        const info = await stat(join(base, name));
        hash.update(`${sub}/${name}:${info.size}:${info.mtimeMs}\n`);
      } catch {
        // Deleted between readdir and stat; the next poll sees the final state.
      }
    }
  }
  return hash.digest('hex');
}

/**
 * @param {string} dir
 * @param {() => void} onChange called (debounced) when the signature changes
 * @param {{intervalMs?: number}} [options]
 */
export function createWatcher(dir, onChange, { intervalMs = 2000 } = {}) {
  let last = null;
  let checking = false;
  let debounce = null;
  let closed = false;
  const watchers = new Map();

  async function check() {
    if (checking || closed) return;
    checking = true;
    try {
      const signature = await computeSignature(dir);
      if (last !== null && signature !== last) onChange();
      last = signature;
    } finally {
      checking = false;
    }
    arm();
  }

  function hint() {
    clearTimeout(debounce);
    debounce = setTimeout(check, DEBOUNCE_MS);
  }

  // Re-armed on every poll: `batches/` may not exist yet, and a watcher dies
  // with its directory.
  function arm() {
    for (const sub of WATCHED_SUBDIRS) {
      if (watchers.has(sub) || closed) continue;
      try {
        const watcher = watch(join(dir, sub), { persistent: false }, hint);
        watcher.on('error', () => { watcher.close(); watchers.delete(sub); });
        watchers.set(sub, watcher);
      } catch {
        // Directory missing or watches exhausted: the poll still covers it.
      }
    }
  }

  const timer = setInterval(check, intervalMs);
  timer.unref();
  check();

  return {
    check,
    close() {
      closed = true;
      clearInterval(timer);
      clearTimeout(debounce);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
