// The report's storage when a cycle is a directory: everything handler.mjs needs
// from disk, and nothing else. The hosted server has the same shape over a database.
//
//   listCycles()                 [{id, isArchive, label?}]  what exists; ids are validated against this list
//   openCycle(entry)             {id, isArchive, signature(), build(), human(actor),
//                                 readSummary(raw), openAttachment(taskId, name)}
//   watch(onChange, {isActive})  {close()}

import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ANSWERS_FILE } from './answers.mjs';
import { openCycle } from './cycle.mjs';
import { findProject, listCycles } from './read.mjs';
import { computeSignature, createWatcher } from './watch.mjs';

/**
 * @param {object} where
 * @param {string} where.dir        the output directory
 * @param {string|null} [where.slug]
 * @param {string|null} [where.project]  project root, when it cannot be found by walking up
 * @param {object|null} [where.enrich]   from enrich.mjs
 */
export function createFileBackend({ dir, slug = null, project = null, enrich = null }) {
  const root = resolve(dir);
  const found = findProject(root);
  const projectRoot = project ? resolve(project) : found.root;

  return {
    root,

    listCycles() {
      return listCycles(root);
    },

    openCycle(entry) {
      const source = openCycle({ root, dir: entry.dir, slug, cycleId: entry.id, isArchive: entry.isArchive, config: found.config });
      return {
        id: entry.id,
        isArchive: entry.isArchive,

        /** Cheap, and different whenever a rebuild could give a different model. */
        async signature() {
          // Answers live beside the cycles, not inside one, so an archive's own signature never sees them change.
          const answersFile = await stat(join(root, ANSWERS_FILE)).catch(() => null);
          return `${await computeSignature(entry.dir)}|${answersFile ? `${answersFile.mtimeMs}:${answersFile.size}` : 'none'}|${enrich?.version() ?? 0}`;
        },

        build() {
          return source.build({ enrichment: enrich ? (raw) => enrich.snapshot(raw, projectRoot) : null });
        },

        /** Files have no notion of who is writing. */
        human() {
          return source.human;
        },

        readSummary(raw) {
          return readFile(join(raw.cycle.dir, raw.summaryFile), 'utf8').catch(() => '');
        },

        /** The handler has already checked both names and the type. */
        async openAttachment(taskId, name) {
          const base = join(entry.dir, 'attachments');
          try {
            const real = await realpath(join(base, taskId, name));
            // A symlink inside attachments/ must not reach outside it.
            if (!real.startsWith((await realpath(base)) + sep)) return null;
            if (!(await stat(real)).isFile()) return null;
            return { etag: null, open: async () => createReadStream(real) };
          } catch {
            return null;
          }
        },
      };
    },

    /** Started at once: a watcher armed after the first change would take that change as its baseline. */
    watch(onChange) {
      const watcher = createWatcher(root, onChange);
      enrich?.onChange(onChange);
      return watcher;
    },
  };
}
