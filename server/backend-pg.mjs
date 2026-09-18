// The report handler's backend (see scripts/report/backend-files.mjs for the
// shape) over Postgres, for one project and one developer's cycles.

import { openCycleFrom } from '../scripts/report/cycle.mjs';
import { createPgSource } from './source-pg.mjs';
import { createPgHumanStore } from './store-pg.mjs';

const POLL_MS = 2000;

export function createPgBackend(db, { projectId, ownerId, readOnly = true }) {
  const source = createPgSource(db, { projectId, ownerId, readOnly });

  return {
    listCycles: () => source.listCycles(),

    openCycle(entry) {
      const cycle = openCycleFrom({
        reader: source.reader(entry.id),
        // Never memoised: "live" is whichever cycle is live when the question is asked. A store kept
        // from before a new cycle arrived would write its ticks onto the archived one.
        humanFor: (raw, actor) => createPgHumanStore(db, { projectId, cycleUuid: raw.cycle.uuid, isArchive: raw.cycle.isArchive, actor }),
      });
      return {
        id: entry.id,
        isArchive: entry.isArchive,
        signature: () => source.signature(entry.id),
        // Pull request and worktree state was gathered on the laptop and came with the push.
        build: () => cycle.build({ enrichment: (raw) => raw.enrichment }),
        human: (actor) => cycle.humanAs(actor),
        readSummary: () => source.summaryText(entry.id),
        openAttachment: (taskId, name) => source.attachment(entry.id, taskId, name),
      };
    },

    /**
     * The same stance as watch.mjs: a cheap poll is the truth, and only while somebody is
     * looking. A push or an answer from another process is seen here within two seconds.
     */
    watch(onChange, { isActive = () => true } = {}) {
      let last = null;
      let checking = false;
      const timer = setInterval(async () => {
        if (checking) return;
        if (!isActive()) { last = null; return; }
        checking = true;
        try {
          const signature = await source.signature('live');
          // The first look after a quiet spell has no baseline to compare with, so it asks for a refresh
          // rather than take whatever happened meanwhile as the baseline. An unchanged model repaints nobody.
          if (signature !== last) onChange();
          last = signature;
        } catch {
          // The database blinked; the next tick asks again.
        } finally {
          checking = false;
        }
      }, POLL_MS);
      timer.unref();
      return { close: () => clearInterval(timer) };
    },
  };
}
