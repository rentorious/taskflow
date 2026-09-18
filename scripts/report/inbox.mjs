// The "Needs you" inbox: everything in a cycle that waits on the developer
// rather than on code. Pure functions only; tick persistence lives in ticks.mjs.
//
// Items come from three origins:
//   index          structured fields triage wrote (tasks.<id>.needs[], suggestions[],
//                  already_fixed + note)
//   plan-fallback  a plan file's "## Open Question" section, for cycles triaged
//                  before schema v2
//   derived        problems computed from pipeline state (stale lock, orphaned
//                  claim, ...). These are not tickable: they vanish when fixed.

import { createHash } from 'node:crypto';
import { renderMarkdown } from './markdown.mjs';

/** Allowed tick resolutions per item kind, in the order a human walks them. */
export const RESOLUTIONS = {
  question: ['sent', 'answered', 'dropped'],
  'owed-write': ['done'],
  todo: ['done'],
  'verify-close': ['verified', 'closed'],
  suggestion: ['filed', 'dismissed'],
};

// A question that was sent still needs an answer; a verified fix still needs
// closing. Those resolutions park the item in "waiting" instead of finishing it.
const WAITING_RESOLUTIONS = new Set(['sent', 'verified']);

// Lower rank sorts first. Broken pipeline state outranks everything because it
// silently stops /taskflow:implement from claiming work.
const KIND_RANK = {
  'stale-lock': 0,
  'orphaned-claim': 1,
  'dep-problem': 2,
  'pr-closed': 3,
  'pr-attention': 4,
  question: 10,
  'owed-write': 20,
  todo: 21,
  'verify-close': 30,
  suggestion: 40,
  'leftover-worktree': 50,
};

const KEY_PATTERN = /^[a-z0-9-]{1,32}$/;
const MAX_OPTIONS = 8;
const MAX_OPTION_CHARS = 120;

// Options join the hash only when there are any, so every fingerprint stored
// before options existed stays valid.
export function fingerprint(title, text, options = null) {
  const tail = options?.length ? `\n${options.join('\n')}` : '';
  return createHash('sha1').update(`${title ?? ''}\n${text ?? ''}${tail}`).digest('hex').slice(0, 12);
}

function cleanOptions(value) {
  if (!Array.isArray(value)) return null;
  const options = value.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim().slice(0, MAX_OPTION_CHARS)).slice(0, MAX_OPTIONS);
  return options.length ? options : null;
}

export function itemId(kind, subjectId, key) {
  return `${kind}:${subjectId}:${key}`;
}

/** open | waiting | handled | changed, from the item and its stored tick. */
export function resolveState(item, tick) {
  if (!item.tickable || !tick || !tick.resolution) {
    const alreadyDelivered = item.kind === 'question' && item.delivered && item.delivered !== 'none';
    return { state: alreadyDelivered ? 'waiting' : 'open', resolution: null, resolvedAt: null, userNote: null };
  }
  const base = { resolution: tick.resolution, resolvedAt: tick.at ?? null, userNote: tick.note || null };
  // Re-triage reworded the item after it was ticked: say so rather than
  // silently unticking it (constant churn) or silently keeping it (stale).
  if (tick.fingerprint && tick.fingerprint !== item.fingerprint) return { state: 'changed', ...base };
  return { state: WAITING_RESOLUTIONS.has(tick.resolution) ? 'waiting' : 'handled', ...base };
}

function makeItem({ kind, origin, subject, key, title, text = '', copyText = null, command = null, to = null, blocking = false, delivered = null, options = null, order = 0 }) {
  const tickable = origin !== 'derived';
  return {
    id: itemId(kind, subject.id, key),
    kind,
    origin,
    subject,
    title,
    text,
    bodyHtml: text ? renderMarkdown(text).html : '',
    copyText,
    command,
    to,
    blocking,
    delivered,
    options,
    fingerprint: fingerprint(title, text, options),
    tickable,
    resolutions: tickable ? RESOLUTIONS[kind] ?? RESOLUTIONS.todo : [],
    rank: (KIND_RANK[kind] ?? 25) * 1000 + (blocking ? 0 : 500) + Math.min(order, 499),
  };
}

function needItems(task, batchOrder, problems) {
  const items = [];
  const seen = new Set();
  for (const need of Array.isArray(task.raw.needs) ? task.raw.needs : []) {
    if (!need || typeof need !== 'object') continue;
    const kind = need.kind === 'question' || need.kind === 'owed-write' ? need.kind : 'todo';
    const text = typeof need.text === 'string' ? need.text : '';
    const title = need.title || (kind === 'question' ? `Ask about ${task.shortName}` : task.shortName);
    const options = kind === 'question' ? cleanOptions(need.options) : null;

    // A need with a bad or repeated key must not vanish: dropping a blocking
    // question would open the claim gate. Keep it under a key made from its
    // content, and say so.
    let key = KEY_PATTERN.test(need.key ?? '') ? need.key : null;
    if (!key || seen.has(key)) {
      const made = `q-${fingerprint(title, text, options)}`;
      if (seen.has(made)) continue; // the same need written twice
      problems?.push({
        code: 'need-key',
        subject: task.id,
        message: key
          ? `Two needs share the key "${key}". The second one is kept under "${made}"; re-run triage to give it a stable key.`
          : `A need has no usable key (lowercase letters, digits and dashes, 32 at most). It is kept under "${made}"; re-run triage to give it a stable key.`,
        since: null,
        usingLastGood: false,
      });
      key = made;
    }
    seen.add(key);

    items.push(makeItem({
      kind,
      origin: 'index',
      subject: { type: 'task', id: task.id, batch: task.batch },
      key,
      title,
      text,
      copyText: text || null,
      to: typeof need.to === 'string' ? need.to : null,
      blocking: need.blocking === true,
      delivered: kind === 'question' ? (need.delivered ?? 'none') : null,
      options,
      order: batchOrder,
    }));
  }
  return items;
}

/**
 * Items that come from tasks and the index. They need no lane, and lanes need
 * them: an open blocking question keeps its batch out of Ready.
 *
 * @param {object} ctx
 * @param {object[]} ctx.tasks        task views (with .raw index entry, .openQuestion fallback text)
 * @param {string[]} ctx.batchOrder   batch keys in claim order
 * @param {object[]} ctx.suggestions  index.suggestions
 * @param {object[]} [ctx.problems]   health problems are appended here
 */
export function deriveTaskItems({ tasks, batchOrder, suggestions, problems }) {
  const items = [];
  const orderOf = new Map(batchOrder.map((key, i) => [key, i]));

  for (const task of tasks) {
    const order = orderOf.get(task.batch) ?? 400;
    const fromIndex = needItems(task, order, problems);
    items.push(...fromIndex);

    // Only fall back when triage wrote no `needs` at all; an explicit empty
    // array means "triage looked and nothing is needed".
    if (!Array.isArray(task.raw.needs) && task.openQuestion) {
      items.push(makeItem({
        kind: 'question',
        origin: 'plan-fallback',
        subject: { type: 'task', id: task.id, batch: task.batch },
        key: 'question',
        title: `Ask about ${task.shortName}`,
        text: task.openQuestion,
        copyText: task.openQuestion,
        blocking: task.confidence === 'low',
        delivered: 'none',
        order,
      }));
    }

    if (task.raw.already_fixed === true) {
      items.push(makeItem({
        kind: 'verify-close',
        origin: 'index',
        subject: { type: 'task', id: task.id, batch: task.batch },
        key: 'fixed',
        title: `Verify and close ${task.shortName}`,
        text: typeof task.raw.note === 'string' ? task.raw.note : '',
        order,
      }));
    }
  }

  const seenSuggestions = new Set();
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (!s || !KEY_PATTERN.test(s.key ?? '') || seenSuggestions.has(s.key)) continue;
    seenSuggestions.add(s.key);
    items.push(makeItem({
      kind: 'suggestion',
      origin: 'index',
      subject: { type: 'cycle', id: 'cycle', batch: null },
      key: s.key,
      title: s.title || 'Suggested new ticket',
      text: typeof s.text === 'string' ? s.text : '',
      copyText: typeof s.text === 'string' ? s.text : null,
    }));
  }
  return items;
}

/** Problems computed from pipeline state. These need every batch's lane. */
export function deriveBatchItems(batches) {
  return batches.flatMap((b, order) => derivedItems(b, order));
}

/** Attach each item's state from what the developer recorded. First id wins. */
export function resolveItems(items, ticks) {
  const byId = {};
  for (const item of items) {
    if (byId[item.id]) continue;
    byId[item.id] = { ...item, ...resolveState(item, ticks?.items?.[item.id]) };
  }
  return byId;
}

function derivedItems(b, order) {
  const subject = { type: 'batch', id: b.key, batch: b.key };
  const base = { origin: 'derived', subject, order };
  const out = [];

  // A closed pull request keeps its lock like any finished batch; that case has its own item below.
  if (b.locked && (b.laneReason === 'stale-lock' || (b.lane === 'stale' && b.laneReason !== 'pr-closed'))) {
    out.push(makeItem({
      ...base, kind: 'stale-lock', key: 'lock',
      title: `Release the stale lock on batch ${b.number ?? b.key}`,
      text: b.lane === 'stale'
        ? 'Every task in this batch left "to do" in the provider, but the claim lock is still on disk.'
        : 'This batch is locked but was never started, so `/taskflow:implement` skips it. A session probably crashed while claiming it.',
      command: b.unlockCommand,
    }));
  }
  if (b.laneReason === 'orphaned') {
    out.push(makeItem({
      ...base, kind: 'orphaned-claim', key: 'claim',
      title: `Batch ${b.number ?? b.key} is in progress with no lock`,
      text: 'The batch file says in progress but nothing holds the claim. Running implement on it re-locks the batch and resumes at the first uncommitted task.',
      command: b.command,
    }));
  }
  if (['dep-stale', 'dep-missing', 'dep-cycle'].includes(b.laneReason)) {
    const why = {
      'dep-stale': 'A batch it depends on went stale, so auto-claim will never reach it. Claim it by name and implement will ask how to proceed.',
      'dep-missing': 'It depends on a batch that does not exist in this cycle. Re-run triage, or claim it by name.',
      'dep-cycle': 'Its dependencies form a loop, so no batch in the loop can ever be auto-claimed. Claim one by name to break it.',
    }[b.laneReason];
    out.push(makeItem({
      ...base, kind: 'dep-problem', key: b.laneReason,
      title: `Batch ${b.number ?? b.key} can never be auto-claimed`,
      text: why,
      command: b.command,
    }));
  }
  if (b.laneReason === 'pr-closed') {
    out.push(makeItem({
      ...base, kind: 'pr-closed', key: 'pr',
      title: `The pull request for batch ${b.number ?? b.key} was closed without merging`,
      text: 'Batches that depend on this one still treat it as complete. Reopen the pull request, or re-triage.',
    }));
  }
  if (b.lane === 'pr-open' && b.pr && (b.pr.checks === 'failing' || b.pr.reviewDecision === 'CHANGES_REQUESTED')) {
    const reasons = [
      b.pr.checks === 'failing' ? 'checks are failing' : null,
      b.pr.reviewDecision === 'CHANGES_REQUESTED' ? 'a reviewer requested changes' : null,
    ].filter(Boolean).join(' and ');
    out.push(makeItem({
      ...base, kind: 'pr-attention', key: 'pr',
      title: `${b.pr.number ? `Pull request #${b.pr.number}` : 'The pull request'} needs work`,
      text: `On batch ${b.number ?? b.key}, ${reasons}.`,
    }));
  }
  if (b.lane === 'shipped' && b.worktree?.exists) {
    out.push(makeItem({
      ...base, kind: 'leftover-worktree', key: 'worktree',
      title: `Remove the worktree for batch ${b.number ?? b.key}`,
      text: 'The pull request merged. The worktree is still on disk; implement never removes it because it may hold unpushed commits.',
      command: `git worktree remove ${JSON.stringify(b.worktree.path)}`,
    }));
  }
  return out;
}
