// Optional enrichment from `gh` and `git`.
//
// The pipeline never learns that a pull request merged: implement stops at
// "pr-created". Without asking GitHub, "shipped" stays empty and leftover
// worktrees stay invisible. Everything here is additive and fails quiet: no gh,
// no auth, no network or no git all produce the same lanes as no enrichment.
//
// Lookups never block a page load. snapshot() answers from cache and schedules
// refreshes in the background; listeners are told when something new lands.

import { execFile } from 'node:child_process';

export const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const OPEN_TTL_MS = 120 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const WORKTREE_TTL_MS = 60 * 1000;
const GH_TIMEOUT_MS = 8000;
const GIT_TIMEOUT_MS = 4000;
const MAX_PARALLEL = 3;

const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);

/** Collapse GitHub's statusCheckRollup into one word. */
export function summarizeChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let pending = false;
  for (const check of rollup) {
    const verdict = check.conclusion || check.state || '';
    if (FAILING.has(verdict)) return 'failing';
    if (PENDING.has(verdict) || PENDING.has(check.status) || (!verdict && check.status !== 'COMPLETED')) pending = true;
  }
  return pending ? 'pending' : 'passing';
}

/** Parse `git worktree list --porcelain` into [{path, branch}]. */
export function parseWorktrees(output) {
  const trees = [];
  for (const block of String(output ?? '').split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path && branch) trees.push({ path, branch });
  }
  return trees;
}

function run(file, args, options) {
  return new Promise((resolve) => {
    // execFile, never a shell: arguments come from files another process wrote.
    execFile(file, args, { ...options, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * @param {{exec?: typeof run, now?: () => number}} [options] injectable for tests
 */
export function createEnricher({ exec = run, now = Date.now } = {}) {
  const prs = new Map(); // url -> {data, fetchedAt}
  const listeners = new Set();
  const pending = new Set();
  const queue = [];
  let active = 0;
  let version = 0;
  let gh = 'ok';
  let ghRetryAt = 0;
  let git = 'disabled';
  let worktrees = { root: null, list: [], fetchedAt: 0 };
  let asOf = null;
  let closed = false;

  function changed() {
    version++;
    asOf = new Date(now()).toISOString();
    for (const listener of listeners) listener();
  }

  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  }

  function pump() {
    while (active < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      active++;
      track(job().finally(() => { active--; pump(); }));
    }
  }

  async function fetchPr(url, cwd) {
    const result = await exec('gh', ['pr', 'view', url, '--json', 'state,isDraft,reviewDecision,statusCheckRollup,mergedAt'], {
      cwd: cwd ?? undefined,
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
    });
    if (closed) return;
    const before = JSON.stringify(prs.get(url)?.data ?? null) + gh;

    if (result.error) {
      if (result.error.code === 'ENOENT') { gh = 'unavailable'; ghRetryAt = now() + NEGATIVE_TTL_MS; }
      else if (/auth|logged in|login/i.test(result.stderr)) { gh = 'unauthenticated'; ghRetryAt = now() + NEGATIVE_TTL_MS; }
      // Anything else (network, no access to that repo): remember the miss for this one URL.
      prs.set(url, { data: prs.get(url)?.data ?? null, fetchedAt: now(), failed: true });
    } else {
      try {
        const body = JSON.parse(result.stdout);
        gh = 'ok';
        prs.set(url, {
          fetchedAt: now(),
          failed: false,
          data: {
            state: { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }[body.state] ?? 'unknown',
            isDraft: body.isDraft === true,
            reviewDecision: body.reviewDecision || null,
            checks: summarizeChecks(body.statusCheckRollup),
            mergedAt: body.mergedAt || null,
            asOf: new Date(now()).toISOString(),
          },
        });
      } catch {
        prs.set(url, { data: prs.get(url)?.data ?? null, fetchedAt: now(), failed: true });
      }
    }
    if (JSON.stringify(prs.get(url)?.data ?? null) + gh !== before) changed();
  }

  function wantPr(url, cwd) {
    if (!PR_URL.test(url)) return;
    if (gh !== 'ok' && now() < ghRetryAt) return;
    const hit = prs.get(url);
    if (hit) {
      if (hit.inFlight) return;
      const settled = hit.data && hit.data.state !== 'open' && hit.data.state !== 'unknown';
      if (settled) return; // merged and closed never change back
      if (now() - hit.fetchedAt < (hit.failed ? NEGATIVE_TTL_MS : OPEN_TTL_MS)) return;
    }
    prs.set(url, { ...(hit ?? { data: null, fetchedAt: 0 }), inFlight: true });
    queue.push(() => fetchPr(url, cwd));
    pump();
  }

  async function fetchWorktrees(root) {
    const result = await exec('git', ['-C', root, 'worktree', 'list', '--porcelain'], { timeout: GIT_TIMEOUT_MS });
    if (closed) return;
    const before = JSON.stringify(worktrees.list) + git;
    git = result.error ? 'unavailable' : 'ok';
    worktrees = { root, list: result.error ? [] : parseWorktrees(result.stdout), fetchedAt: now(), inFlight: false };
    if (JSON.stringify(worktrees.list) + git !== before) changed();
  }

  function wantWorktrees(root) {
    if (!root) return;
    if (worktrees.inFlight) return;
    if (worktrees.root === root && now() - worktrees.fetchedAt < WORKTREE_TTL_MS) return;
    worktrees = { ...worktrees, root, inFlight: true };
    track(fetchWorktrees(root));
  }

  return {
    version: () => version,
    onChange(listener) { listeners.add(listener); },
    /** Resolves once every lookup that is queued or running has finished. */
    async settle() {
      while (pending.size || queue.length) await Promise.allSettled([...pending]);
    },
    close() { closed = true; listeners.clear(); queue.length = 0; },

    /** Current knowledge for a cycle. Schedules refreshes; never waits for them. */
    snapshot(raw, projectRoot) {
      const found = {};
      for (const file of Object.values(raw.batchFiles ?? {})) {
        const url = file?.data?.pr_url;
        if (typeof url !== 'string') continue;
        wantPr(url, projectRoot);
        const data = prs.get(url)?.data;
        if (data) found[url] = data;
      }
      wantWorktrees(projectRoot);
      return { git: projectRoot ? git : 'disabled', gh, asOf, prs: found, worktrees: worktrees.root === projectRoot ? worktrees.list : [] };
    },
  };
}
