import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEnricher, parseWorktrees, summarizeChecks } from '../scripts/report/enrich.mjs';

const PR = 'https://github.com/example/harbor-books/pull/102';
const raw = (url = PR) => ({ batchFiles: { 'batch-2': { data: { pr_url: url } } } });

test('check rollups collapse to one word', () => {
  assert.equal(summarizeChecks([]), 'none');
  assert.equal(summarizeChecks(null), 'none');
  assert.equal(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'passing');
  assert.equal(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(summarizeChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failing');
  assert.equal(summarizeChecks([{ state: 'PENDING' }]), 'pending', 'legacy status contexts');
  assert.equal(summarizeChecks([{ state: 'ERROR' }]), 'failing');
});

test('worktree porcelain output', () => {
  const out = 'worktree /home/sam/harbor\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/sam/harbor-feat-x\nHEAD def\nbranch refs/heads/feat/x\n\nworktree /home/sam/detached\nHEAD 123\ndetached\n';
  assert.deepEqual(parseWorktrees(out), [{ path: '/home/sam/harbor', branch: 'main' }, { path: '/home/sam/harbor-feat-x', branch: 'feat/x' }]);
});

test('never blocks: first snapshot is empty, the result lands later and bumps the version', async () => {
  const calls = [];
  const enrich = createEnricher({
    exec: async (file, args) => {
      calls.push([file, ...args].join(' '));
      if (file === 'git') return { error: null, stdout: 'worktree /w\nbranch refs/heads/feat/restock-badge\n', stderr: '' };
      return { error: null, stdout: JSON.stringify({ state: 'MERGED', isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [], mergedAt: '2026-01-10T10:00:00Z' }), stderr: '' };
    },
  });
  let notified = 0;
  enrich.onChange(() => notified++);

  assert.deepEqual(enrich.snapshot(raw(), '/project').prs, {});
  await enrich.settle();
  const after = enrich.snapshot(raw(), '/project');
  assert.equal(after.prs[PR].state, 'merged');
  assert.equal(after.gh, 'ok');
  assert.equal(after.git, 'ok');
  assert.deepEqual(after.worktrees, [{ path: '/w', branch: 'feat/restock-badge' }]);
  assert.ok(notified >= 1 && enrich.version() >= 1);

  await enrich.settle();
  assert.equal(calls.filter((c) => c.startsWith('gh ')).length, 1, 'a merged pull request is never asked about again');
  assert.ok(calls[0].startsWith(`gh pr view ${PR} --json`), calls[0]);
});

test('only real GitHub pull request URLs reach gh', async () => {
  const calls = [];
  const enrich = createEnricher({ exec: async (file, args) => { calls.push(args); return { error: null, stdout: '{}', stderr: '' }; } });
  for (const bad of ['https://evil.example.com/pull/1', 'https://github.com/a/b/pull/1; rm -rf ~', '--help', 'https://github.com/a/b/pull/1/files', 42]) enrich.snapshot(raw(bad), null);
  await enrich.settle();
  assert.deepEqual(calls, []);
});

test('no gh installed: quiet, and not retried for a while', async () => {
  let ghCalls = 0;
  const enrich = createEnricher({ exec: async (file) => { if (file === 'gh') ghCalls++; return { error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' }; } });
  enrich.snapshot(raw(), null);
  await enrich.settle();
  const state = enrich.snapshot(raw('https://github.com/example/harbor-books/pull/103'), null);
  await enrich.settle();
  assert.equal(state.gh, 'unavailable');
  assert.deepEqual(state.prs, {});
  assert.equal(ghCalls, 1);
});

test('not logged in is reported as such', async () => {
  const enrich = createEnricher({ exec: async () => ({ error: new Error('exit 4'), stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }) });
  enrich.snapshot(raw(), null);
  await enrich.settle();
  assert.equal(enrich.snapshot(raw(), null).gh, 'unauthenticated');
});
