// Pure view-model builder: (RawCycle, ticks, enrichment, now) -> ViewModel.
// No file or network access here, so every rule below is unit-testable.
//
// Guiding rule for lanes: "Ready" is, in the same order, what `taskflow claim`
// with no arguments takes. That holds by construction: claim runs gate.mjs over
// this model and reads the Ready lane. implement no longer restates the rule.

import { createHash } from 'node:crypto';
import { parseEstimate, sumEstimates } from './estimates.mjs';
import { blocksClaim } from './gate.mjs';
import { deriveBatchItems, deriveTaskItems, resolveItems } from './inbox.mjs';
import { extractFiles, parsePlan, renderMarkdown, safeUrl } from './markdown.mjs';

export const MODEL_VERSION = 1;

// implement takes the lock first and only writes "in-progress" after a round of
// provider calls, so a young lock on a pending batch is a session starting up.
export const CLAIMING_WINDOW_MS = 10 * 60 * 1000;
export const QUIET_AFTER_MS = 45 * 60 * 1000;

const KNOWN_STATUSES = new Set(['pending', 'in-progress', 'pr-created', 'stale', 'done']);
const COMPLETE = new Set(['pr-created', 'done']);
const SHORT_NAME_MAX = 70;

const SCALE = {
  size: ['small', 'medium', 'large'],
  confidence: ['low', 'medium', 'high'],
  priority: ['low', 'normal', 'high', 'urgent'],
  implementable: ['no', 'partial', 'yes'],
};

const LANES = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'ready', label: 'Ready to start' },
  { id: 'in-flight', label: 'In flight' },
  { id: 'pr-open', label: 'Pull request open' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Shipped and stale' },
  { id: 'unbatched', label: 'Not batched' },
];

const FACETS = [
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Size' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'area', label: 'Area' },
  { key: 'priority', label: 'Priority' },
  { key: 'implementable', label: 'Automation' },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function batchNumber(key) {
  const m = /^batch-(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** Numeric claim order. "batch-10" must not sort before "batch-2". */
export function orderBatchKeys(keys) {
  const numbered = keys.filter((k) => batchNumber(k) !== null).sort((a, b) => batchNumber(a) - batchNumber(b));
  return [...numbered, ...keys.filter((k) => batchNumber(k) === null)];
}

function shorten(name) {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= SHORT_NAME_MAX) return text;
  const cut = text.slice(0, SHORT_NAME_MAX);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > 40 ? space : SHORT_NAME_MAX).replace(/[\s,;:.-]+$/, '')}…`;
}

const rankIn = (scale, value) => SCALE[scale].indexOf(value);
const highest = (scale, values) => values.filter((v) => rankIn(scale, v) >= 0).sort((a, b) => rankIn(scale, b) - rankIn(scale, a))[0] ?? null;
const lowest = (scale, values) => values.filter((v) => rankIn(scale, v) >= 0).sort((a, b) => rankIn(scale, a) - rankIn(scale, b))[0] ?? null;
const unique = (values) => [...new Set(values.filter(Boolean))];

function prNumber(url) {
  const m = /\/pull\/(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Keys that sit on a dependency loop (DFS reachability; cycles are tiny). */
function findCycleMembers(graph) {
  const members = new Set();
  for (const start of Object.keys(graph)) {
    const stack = [...(graph[start] ?? [])];
    const visited = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (node === start) { members.add(start); break; }
      if (visited.has(node)) continue;
      visited.add(node);
      stack.push(...(graph[node] ?? []));
    }
  }
  return members;
}

function isStaleFile(file) {
  if (!file) return false;
  if (file.status === 'stale') return true;
  const statuses = Object.values(file.tasks ?? {}).map((t) => t?.status);
  return statuses.length > 0 && statuses.every((s) => s === 'stale');
}

// ---------------------------------------------------------------------------
// Lane derivation — first match wins. Row numbers refer to the design table.
// ---------------------------------------------------------------------------

export function deriveLane({ status, locked, lockAgeMs, fileStale, indexTasksAllStale, depReason, prState, questionsOpen = 0 }) {
  if (status === 'done') return { lane: 'shipped', reason: null };                              // 1
  if (status === 'pr-created') {
    if (prState === 'merged') return { lane: 'shipped', reason: null };                          // 2
    if (prState === 'closed') return { lane: 'stale', reason: 'pr-closed' };                     // 3
    return { lane: 'pr-open', reason: null };                                                    // 4 — a lock here is normal
  }
  if (fileStale) return { lane: 'stale', reason: null };                                         // 5
  if (status === 'in-progress') return { lane: 'in-flight', reason: locked ? null : 'orphaned' }; // 6, 7
  if (locked) {
    return lockAgeMs !== null && lockAgeMs < CLAIMING_WINDOW_MS
      ? { lane: 'in-flight', reason: 'claiming' }                                                // 8
      : { lane: 'blocked', reason: 'stale-lock' };                                               // 9
  }
  if (indexTasksAllStale) return { lane: 'stale', reason: 'tasks-left-todo' };                   // 10
  if (depReason) return { lane: 'blocked', reason: depReason };                                  // 11 — outranks questions: answering alone would not free it
  if (questionsOpen > 0) return { lane: 'blocked', reason: 'waiting-on-answers' };               // 12
  return { lane: 'ready', reason: null };                                                        // 13
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function buildTask(id, entry, raw) {
  const c = entry.classification ?? {};
  const plan = raw.plans?.[id] ?? null;
  const parsed = plan ? parsePlan(plan.markdown) : null;
  const filesSection = parsed?.sections.find((s) => s.slug.startsWith('files'));
  const question = parsed?.sections.find((s) => s.slug === 'open-question');

  let disposition = 'unassigned';
  if (entry.batch) disposition = 'batched';
  else if (entry.already_fixed === true) disposition = 'already-fixed';
  else if (entry.duplicate_of) disposition = 'duplicate';
  else if (c.implementable === 'no' || c.area === 'manual') disposition = 'manual';

  return {
    id,
    raw: entry,
    name: String(entry.name ?? id),
    shortName: entry.short_name ? String(entry.short_name) : shorten(entry.name ?? id),
    summary: typeof entry.summary === 'string' ? entry.summary : null,
    url: safeUrl(entry.url),
    batch: entry.batch ?? null,
    disposition,
    type: c.type ?? null,
    size: c.complexity ?? null,
    confidence: c.confidence ?? null,
    area: c.area ?? null,
    priority: entry.priority ?? null,
    implementable: c.implementable ?? null,
    status: null,
    commitShas: [],
    prUrl: null,
    indexStale: entry.stale === true,
    staleSince: entry.stale_since ?? null,
    providerStatus: entry.provider_status ?? null,
    carriedOverFrom: entry.carried_over_from ?? null,
    duplicateOf: entry.duplicate_of ?? null,
    noteHtml: typeof entry.note === 'string' ? renderMarkdown(entry.note).html : null,
    estimate: { agent: parseEstimate(c.time_estimate_agent), human: parseEstimate(c.time_estimate_human) },
    plan: plan
      ? { exists: true, bytes: plan.bytes, mtimeMs: plan.mtimeMs, sections: parsed.sections.map((s) => ({ title: s.title, slug: s.slug })) }
      : { exists: false, bytes: 0, mtimeMs: null, sections: [] },
    files: filesSection ? extractFiles(filesSection.markdown).map((f) => f.path) : [],
    attachments: raw.attachments?.[id]?.length ?? 0,
    openQuestion: question?.markdown || null,
    inboxIds: [],
  };
}

/** Rendered plan for the detail pane. Shared by /api/task and --snapshot. */
export function buildTaskDetail(raw, id) {
  const plan = raw.plans?.[id];
  const attachments = (raw.attachments?.[id] ?? []).map((a) => ({
    name: a.name, type: a.type, bytes: a.bytes, url: `attachments/${encodeURIComponent(id)}/${encodeURIComponent(a.name)}`,
  }));
  if (!plan) return { id, mtimeMs: null, sections: [], files: [], attachments, truncated: false };

  const parsed = parsePlan(plan.markdown);
  let truncated = false;
  const sections = parsed.sections.map((s) => {
    const rendered = renderMarkdown(s.markdown);
    truncated ||= rendered.truncated;
    return { title: s.title, slug: s.slug, html: rendered.html };
  });
  const filesSection = parsed.sections.find((s) => s.slug.startsWith('files'));
  return { id, mtimeMs: plan.mtimeMs, sections, files: filesSection ? extractFiles(filesSection.markdown) : [], attachments, truncated };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * @param {object} raw  RawCycle
 * @param {object} [context]
 * @param {{items: object, problems?: object[]}} [context.human]  one record per inbox item id, from a HumanStore's load()
 * @param {object} [context.ticks]  the older name for `human`, still accepted
 */
export function buildModel(raw, { human = null, ticks = null, enrichment = null, now = Date.now() } = {}) {
  ticks = human ?? ticks ?? { items: {} };
  const index = raw.index ?? {};
  const indexTasks = index.tasks ?? {};
  const indexBatches = index.batches ?? {};
  const problems = [...(raw.problems ?? []), ...(ticks.problems ?? [])];
  const problem = (code, subject, message) => problems.push({ code, subject, message, since: null, usingLastGood: false });

  const tasks = {};
  for (const [id, entry] of Object.entries(indexTasks)) {
    if (entry && typeof entry === 'object') tasks[id] = buildTask(id, entry, raw);
  }

  const keys = orderBatchKeys(Object.keys(indexBatches));
  const graph = {};
  for (const key of keys) graph[key] = unique(indexBatches[key]?.depends_on ?? []).filter((d) => d !== key);
  const cycleMembers = findCycleMembers(graph);

  // Before any item is made: an item copies its task's batch, and must not keep a dead key.
  for (const t of Object.values(tasks)) {
    if (t.batch && !(t.batch in indexBatches)) {
      problem('batch-missing', t.id, `Task points at ${t.batch}, which is not in the index.`);
      t.disposition = 'unassigned';
      t.batch = null;
    }
  }

  // Question states come first, because an open blocking question decides a lane.
  const taskItems = resolveItems(deriveTaskItems({ tasks: Object.values(tasks), batchOrder: keys, suggestions: index.suggestions, problems }), ticks);
  const itemsByTask = new Map();
  for (const item of Object.values(taskItems)) {
    if (item.subject.type !== 'task') continue;
    if (!itemsByTask.has(item.subject.id)) itemsByTask.set(item.subject.id, []);
    itemsByTask.get(item.subject.id).push(item);
  }

  const batches = {};
  for (const key of keys) {
    const info = indexBatches[key] ?? {};
    const file = raw.batchFiles?.[key] ?? { exists: false, data: null, mtimeMs: null };
    const data = file.data ?? null;
    const lock = raw.locks?.[key] ?? null;
    const flags = [];

    const rawStatus = data?.status ?? null;
    let status = rawStatus ?? 'pending';
    if (!KNOWN_STATUSES.has(status)) {                                                           // 13
      flags.push('unknown-status');
      problem('unknown-status', key, `Batch file has status "${rawStatus}", which the report does not know. Treated as pending.`);
      status = 'pending';
    }
    if (!file.exists) flags.push('no-batch-file');
    if (file.unreadable) flags.push('batch-unreadable');                                         // 14
    if ((indexBatches[key]?.depends_on ?? []).includes(key)) flags.push('self-dependency');

    const taskIds = (Array.isArray(info.tasks) ? info.tasks : []).filter((id) => {
      if (tasks[id]) return true;
      problem('task-missing', key, `Batch lists task ${id}, which is not in the index.`);
      return false;
    });

    const dependsOn = graph[key].map((dep) => {
      const depFile = raw.batchFiles?.[dep]?.data ?? null;
      return {
        key: dep,
        number: batchNumber(dep),
        exists: dep in indexBatches || Boolean(raw.batchFiles?.[dep]?.exists),
        satisfied: COMPLETE.has(depFile?.status),
        stale: isStaleFile(depFile),
      };
    });
    const unsatisfied = dependsOn.filter((d) => !d.satisfied);
    let depReason = null;
    if (unsatisfied.length) {
      if (cycleMembers.has(key)) depReason = 'dep-cycle';
      else if (unsatisfied.some((d) => !d.exists)) depReason = 'dep-missing';
      else if (unsatisfied.some((d) => d.stale)) depReason = 'dep-stale';
      else depReason = 'deps';
    }
    if (depReason === 'dep-missing') problem('dep-missing', key, 'Depends on a batch that does not exist in this cycle.');
    if (depReason === 'dep-cycle') problem('dep-cycle', key, 'Sits on a dependency loop.');

    const prUrl = safeUrl(data?.pr_url);
    const prInfo = prUrl ? enrichment?.prs?.[prUrl] ?? null : null;
    const pr = prUrl
      ? {
          url: prUrl,
          number: prNumber(prUrl),
          state: prInfo?.state ?? 'unknown',
          isDraft: prInfo?.isDraft ?? false,
          reviewDecision: prInfo?.reviewDecision ?? null,
          checks: prInfo?.checks ?? 'unknown',
          mergedAt: prInfo?.mergedAt ?? null,
          asOf: prInfo?.asOf ?? null,
        }
      : null;

    // A task that left "to do" is skipped by implement, so its questions hold nothing up.
    const liveTaskIds = taskIds.filter((id) => !tasks[id].indexStale && data?.tasks?.[id]?.status !== 'stale');
    const blockingItemIds = liveTaskIds.flatMap((id) => (itemsByTask.get(id) ?? []).filter(blocksClaim).map((item) => item.id));

    const lockAgeMs = lock ? Math.max(0, now - lock.mtimeMs) : null;
    const { lane, reason } = deriveLane({
      status,
      locked: Boolean(lock),
      lockAgeMs,
      fileStale: isStaleFile(data),
      indexTasksAllStale: taskIds.length > 0 && taskIds.every((id) => tasks[id].indexStale),
      depReason,
      prState: pr?.state ?? null,
      questionsOpen: blockingItemIds.length,
    });

    const lastActivityMs = Math.max(file.mtimeMs ?? 0, lock?.mtimeMs ?? 0) || null;
    let laneReason = reason;
    if (lane === 'in-flight' && !laneReason && lastActivityMs && now - lastActivityMs > QUIET_AFTER_MS) laneReason = 'quiet';

    const progress = { total: taskIds.length, planned: 0, inProgress: 0, committed: 0, stale: 0 };
    for (const id of taskIds) {
      const entry = data?.tasks?.[id] ?? {};
      const taskStatus = ['planned', 'in-progress', 'committed', 'stale'].includes(entry.status) ? entry.status : 'planned';
      progress[taskStatus === 'in-progress' ? 'inProgress' : taskStatus]++;
      tasks[id].status = taskStatus;
      tasks[id].commitShas = Array.isArray(entry.commit_shas) ? entry.commit_shas.filter((s) => /^[0-9a-f]{7,40}$/i.test(s)) : [];
      tasks[id].prUrl = safeUrl(entry.pr_url) ?? prUrl;
    }

    const branch = typeof data?.branch === 'string' ? data.branch : null;
    const worktreeHit = branch ? enrichment?.worktrees?.find((w) => w.branch === branch) ?? null : null;
    const members = taskIds.map((id) => tasks[id]);
    const locked = Boolean(lock);
    const number = batchNumber(key);

    batches[key] = {
      key,
      number,
      name: String(info.name ?? key),
      lane,
      laneReason,
      claimOrder: null,
      status,
      rawStatus,
      locked,
      lockAgeMs,
      hasBatchFile: Boolean(file.exists),
      lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
      branch,
      suggestedBranch: info.suggested_branch ?? null,
      stackOn: null,
      command: `/taskflow:implement ${key}`,
      unlockCommand: locked ? `/taskflow:implement --unlock ${key}` : null,
      dependsOn,
      blockedBy: unsatisfied.map((d) => d.key),
      unblocks: [],
      taskIds,
      progress,
      rollup: {
        size: highest('size', members.map((t) => t.size)),
        minConfidence: lowest('confidence', members.map((t) => t.confidence)),
        topPriority: highest('priority', members.map((t) => t.priority)),
        areas: unique(members.map((t) => t.area)),
        types: unique(members.map((t) => t.type)),
      },
      estimate: {
        agent: sumEstimates(members.map((t) => t.estimate.agent)),
        human: sumEstimates(members.map((t) => t.estimate.human)),
      },
      rationaleHtml: typeof info.rationale === 'string' ? renderMarkdown(info.rationale).html : null,
      openQuestions: 0,
      blockingQuestions: blockingItemIds.length,
      blockingItemIds,
      hasLowConfidence: members.some((t) => t.confidence === 'low'),
      pr,
      worktree: worktreeHit ? { path: worktreeHit.path, exists: true } : null,
      flags,
    };
  }

  // Second pass: fields that need every batch's lane.
  let claimOrder = 0;
  for (const key of keys) {
    const b = batches[key];
    if (b.lane === 'ready') b.claimOrder = ++claimOrder;
    b.unblocks = keys.filter((other) => batches[other].blockedBy.includes(key));
    for (const dep of b.dependsOn) dep.lane = batches[dep.key]?.lane ?? null;
    // implement stacks on a dependency whose pull request is not merged yet.
    const stack = b.dependsOn.find((d) => d.satisfied && batches[d.key]?.pr && batches[d.key].pr.state !== 'merged');
    if (stack && (b.lane === 'ready' || b.lane === 'blocked')) {
      b.stackOn = { key: stack.key, branch: batches[stack.key].branch, prNumber: batches[stack.key].pr.number };
    }
  }

  for (const t of Object.values(tasks)) {
    // Only worth raising while the batch can still be claimed.
    const claimable = !raw.cycle?.isArchive && ['ready', 'blocked', 'in-flight'].includes(batches[t.batch]?.lane);
    if (t.disposition === 'batched' && !t.plan.exists && claimable) problem('plan-missing', t.id, 'No plan file. Implement will skip this task.');
  }

  const orderedBatches = keys.map((k) => batches[k]);
  const inbox = { ...taskItems };
  for (const [id, item] of Object.entries(resolveItems(deriveBatchItems(orderedBatches), ticks))) inbox[id] ??= item;

  for (const item of Object.values(inbox)) {
    if (item.subject.type === 'task') tasks[item.subject.id]?.inboxIds.push(item.id);
    const b = item.subject.batch ? batches[item.subject.batch] : null;
    if (b && item.kind === 'question' && item.state !== 'handled') b.openQuestions++;
  }

  // -- lanes -----------------------------------------------------------------
  const inboxSorted = Object.values(inbox).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const attention = inboxSorted.filter((i) => i.state === 'open' || i.state === 'changed');
  const waiting = inboxSorted.filter((i) => i.state === 'waiting');
  const handled = inboxSorted.filter((i) => i.state === 'handled');
  const inLane = (...lanes) => keys.filter((k) => lanes.includes(batches[k].lane));
  const unbatched = Object.values(tasks)
    .filter((t) => !t.batch)
    .sort((a, b) => rankIn('priority', b.priority) - rankIn('priority', a.priority) || a.id.localeCompare(b.id))
    .map((t) => t.id);

  const laneOrder = {
    'needs-you': [...attention, ...waiting].map((i) => i.id),
    handled: handled.map((i) => i.id),
    ready: inLane('ready'),
    'in-flight': inLane('in-flight'),
    'pr-open': inLane('pr-open'),
    blocked: inLane('blocked'),
    done: inLane('shipped', 'stale'),
    unbatched,
  };

  const counts = {
    needsYou: attention.length,
    waitingOnClient: waiting.length,
    handled: handled.length,
    ready: laneOrder.ready.length,
    inFlight: laneOrder['in-flight'].length,
    prOpen: laneOrder['pr-open'].length,
    blocked: laneOrder.blocked.length,
    shipped: inLane('shipped').length,
    stale: inLane('stale').length,
    unbatched: unbatched.length,
    tasks: Object.keys(tasks).length,
    batches: keys.length,
  };

  const lanes = LANES.map((lane) => ({
    ...lane,
    count: lane.id === 'needs-you' ? counts.needsYou : laneOrder[lane.id].length,
    attention: lane.id === 'needs-you' && counts.needsYou > 0,
  }));

  // -- facets ----------------------------------------------------------------
  const facets = FACETS.map(({ key, label }) => {
    const tally = new Map();
    for (const t of Object.values(tasks)) if (t[key]) tally.set(t[key], (tally.get(t[key]) ?? 0) + 1);
    const values = [...tally.entries()].map(([value, count]) => ({ value, label: value, count }));
    values.sort((a, b) => (SCALE[key] ? rankIn(key, b.value) - rankIn(key, a.value) : b.count - a.count) || a.value.localeCompare(b.value));
    return { key, label, values };
  });

  const taskViews = {};
  for (const [id, t] of Object.entries(tasks)) {
    const { raw: _raw, openQuestion: _question, ...view } = t;
    taskViews[id] = view;
  }

  const model = {
    modelVersion: MODEL_VERSION,
    version: null,
    generatedAt: new Date(now).toISOString(),
    cycle: {
      id: raw.cycle?.id ?? 'live',
      isArchive: Boolean(raw.cycle?.isArchive),
      // An archive never changes. A hosted cycle can also be read-only for the person looking at it.
      readOnly: Boolean(raw.cycle?.isArchive || raw.cycle?.readOnly),
      dir: raw.cycle?.dir ?? null,
      // Set by the hosted server: the cycle is a mirror of what a laptop last pushed.
      hosted: Boolean(raw.cycle?.hosted),
      uuid: raw.cycle?.uuid ?? null,
      pushedAt: raw.cycle?.pushedAt ?? null,
      pushedFrom: raw.cycle?.pushedFrom ?? null,
      indexFile: raw.cycle?.indexFile ?? null,
      slug: raw.cycle?.slug ?? null,
      empty: !raw.index,
      developer: index.developer ?? null,
      lastTriage: index.last_triage ?? null,
      devHead: index.dev_head ?? null,
      schemaVersion: index.schema_version ?? 1,
      projectName: raw.config?.projectName ?? null,
      baseBranch: raw.config?.baseBranch ?? null,
      summaryFile: raw.summaryFile ?? null,
      providerComments: raw.config?.providerComments === true,
      providerEnrichment: raw.config?.providerEnrichment === true,
    },
    health: {
      ok: problems.length === 0,
      problems,
      enrichment: { git: enrichment?.git ?? 'disabled', gh: enrichment?.gh ?? 'disabled', asOf: enrichment?.asOf ?? null },
    },
    counts,
    lanes,
    laneOrder,
    batches,
    tasks: taskViews,
    inbox,
    facets,
    totals: {
      agent: sumEstimates(Object.values(tasks).map((t) => t.estimate.agent)),
      human: sumEstimates(Object.values(tasks).map((t) => t.estimate.human)),
    },
  };
  model.version = modelFingerprint(model);
  return model;
}

// Fields that tick on every build without the picture changing. Leaving them
// out keeps the ETag stable, so idle tabs do not re-render.
// `pushedAt` moves on every push, changed or not; the stream announces it on its own.
const VOLATILE = new Set(['version', 'generatedAt', 'lockAgeMs', 'asOf', 'pushedAt']);

export function modelFingerprint(model) {
  const json = JSON.stringify(model, (key, value) => (VOLATILE.has(key) ? undefined : value));
  return createHash('sha1').update(json).digest('hex').slice(0, 12);
}
