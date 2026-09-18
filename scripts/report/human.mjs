// Everything a person records about a cycle, behind one interface.
//
// Two files sit behind it, split by lifetime:
//   answers.json                 questions: state and answers. Per project, outlives cycles.
//   report-inbox.<slug>.json     every other kind of tick. Per cycle, archived with it.
//
// Callers route nothing: they hand over an inbox item and the store picks the
// file by the item's kind. The hosted server swaps this module for one backed
// by Postgres and keeps the same methods.

import { join } from 'node:path';
import { ANSWERS_FILE, createAnswerStore } from './answers.mjs';
import { createTickStore } from './ticks.mjs';

export const isQuestion = (id) => id.startsWith('question:');

/** The question behind an inbox item, as a store keys and snapshots it. */
export const questionOf = (item) => ({ taskId: item.subject.id, key: item.id.split(':').slice(2).join(':'), fingerprint: item.fingerprint, title: item.title, text: item.text });

/**
 * @param {object} where
 * @param {string} where.root       the output directory (holds answers.json and archive/)
 * @param {string} where.cycleDir   the cycle being shown: `root`, or one archive under it
 * @param {string|null} where.slug
 * @param {boolean} [where.isArchive]
 */
export function createHumanStore({ root, cycleDir, slug, isArchive = false }) {
  const ticks = createTickStore(cycleDir, slug, { readOnly: isArchive });
  const answers = createAnswerStore(join(root, ANSWERS_FILE), { readOnly: isArchive, archiveRoot: join(root, 'archive') });

  return {
    answersPath: answers.path,

    /** @returns {Promise<{items: object, problems: object[]}>} one record per inbox item id */
    async load(cycle = null) {
      const [tickData, answerData] = await Promise.all([ticks.load(cycle), answers.load()]);
      const items = {};
      for (const [id, tick] of Object.entries(tickData.items ?? {})) {
        // Question ticks predate answers. A bare "answered" tick has no answer behind
        // it, so it may describe an old cycle but must never open a live claim gate.
        if (isQuestion(id) && !isArchive) continue;
        items[id] = tick;
      }
      for (const [id, entry] of Object.entries(answerData.data.items ?? {})) {
        if (entry?.resolution || entry?.answers?.length) items[id] = entry;
      }
      return { items, problems: answerData.problems };
    },

    /** Tick, untick (`resolution: null`), mark sent, drop or reopen. */
    setResolution(item, { resolution, note = '' }, cycle = null) {
      if (item.kind === 'question') return answers.setResolution(item.id, questionOf(item), { resolution, note });
      return ticks.set(item.id, resolution === null ? null : { resolution, fingerprint: item.fingerprint, title: item.title, note }, cycle);
    },

    addAnswer(item, answer) {
      return answers.addAnswer(item.id, questionOf(item), answer);
    },

    confirm(item) {
      return answers.confirm(item.id, questionOf(item));
    },
  };
}
