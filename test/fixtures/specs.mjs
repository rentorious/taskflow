// Synthetic cycles for tests and for the design pass. All invented: a made-up
// bookshop ("Harbor Books"), a made-up client ("Mara"), example.com URLs.
//
//   node test/fixtures/materialize.mjs kitchen-sink /tmp/ks   # then point the server at /tmp/ks

import { fingerprint } from '../../scripts/report/inbox.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const url = (id) => `https://tracker.example.com/t/${id}`;
const pr = (n) => `https://github.com/example/harbor-books/pull/${n}`;

function task(name, { area = 'storefront', type = 'feature', size = 'small', confidence = 'high', implementable = 'yes', priority = 'normal', human = '1-2 hours', agent = '15-25 min', batch = null, ...rest } = {}) {
  return {
    name,
    url: url(rest.id ?? 'x'),
    priority,
    classification: { area, type, complexity: size, confidence, implementable, time_estimate_human: human, time_estimate_agent: agent },
    batch,
    ...rest,
  };
}

function plan(title, { question = null, files = ['apps/storefront/src/components/Shelf.tsx'], extra = '' } = {}) {
  return `# ${title}

**Task:** ${url('x')}
**Area:** storefront | **Type:** feature | **Complexity:** small | **Confidence:** high
**Time Estimate (Human):** 1-2 hours | **Time Estimate (Agent):** 15-25 min
**Batch:** batch-99 (\`feat/stale-header\`) | **Implementable:** yes

## What Needs to Change

The shelf grid renders every cover at full size. Swap to the responsive image helper and cap the row at **four** covers on desktop.

## Files Involved

${files.map((f) => `- \`${f}\``).join('\n')}

## Approach

1. Read the current grid markup.
2. Replace the raw \`<img>\` with the shared helper.
   - Keep the alt text.
   - Keep the lazy-loading attribute.
3. Add a test for the four-cover cap.

\`\`\`ts
const covers = shelf.items.slice(0, 4)
\`\`\`
${extra}
## Risks / Unknowns

The helper does not support animated covers. None are in the catalogue today.

## Dependencies

None.

## Related Tasks

None.
${question ? `\n## Open Question\n\n${question}\n` : ''}`;
}

const HOSTILE_PLAN = plan('Plan with hostile content', {
  extra: `
## Hostile content

Raw tags must show as text: <script>alert('plan')</script> and <img src=x onerror=alert(1)> and <Tags>.

A [bad link](javascript:alert(1)) stays plain text. A [good link](https://example.com/docs?a=1&b=2) works. Bare: https://example.com/path.

| Column | Value |
|---|---|
| \`code\` | **bold** <b>not bold</b> |

> A quoted line with *emphasis*.

- [ ] unchecked
- [x] checked
`,
});

// ---------------------------------------------------------------------------
// kitchen-sink: every lane, every inbox kind, every edge case
// ---------------------------------------------------------------------------

const LONG_TITLE = 'When a customer adds a signed first edition to the basket and then changes the delivery country on the checkout page the gift wrap option disappears and the basket total briefly shows the old shipping price and then Mara says on her phone it also sometimes shows the wrong currency symbol until she refreshes the page twice which she thinks might be related to the banner we added last month but she is not sure';

const ksTasks = {
  hb101: task('Shelf page loads every cover at full size on mobile', { id: 'hb101', type: 'bug', priority: 'urgent', batch: 'batch-1', short_name: 'Shelf covers load at full size on mobile' }),
  hb102: task('Show "Back in stock" badge on restocked titles', { id: 'hb102', batch: 'batch-2', priority: 'high' }),
  hb103: task('Admin: bulk edit of prices from a CSV', { id: 'hb103', area: 'admin', size: 'medium', batch: 'batch-3', priority: 'high', human: '4-6 hours', agent: '45 min - 1 hour' }),
  hb104: task('Admin: CSV import shows which rows failed', { id: 'hb104', area: 'admin', size: 'medium', confidence: 'medium', batch: 'batch-3', human: '3-4 hours', agent: '30-45 min' }),
  hb105: task('Admin: download a template CSV', { id: 'hb105', area: 'admin', batch: 'batch-3', priority: 'low', human: '30 min', agent: '10 min' }),
  hb106: task('Order confirmation email cuts off long titles', { id: 'hb106', area: 'api', type: 'bug', batch: 'batch-4', priority: 'high' }),
  hb107: task('Search should match author names with accents', { id: 'hb107', area: 'api', type: 'bug', batch: 'batch-5', priority: 'urgent', human: '1-2 hours', agent: '20-30 min' }),
  hb108: task('Some orders were charged shipping twice', {
    id: 'hb108', area: 'api', type: 'investigation', size: 'medium', confidence: 'low', implementable: 'partial', batch: 'batch-6', priority: 'urgent',
    human: '2-4 hours', agent: '30 min - 1 hour',
    needs: [{
      key: 'question', kind: 'question', title: 'Ask Mara which orders were double charged', to: 'Mara', blocking: true, delivered: 'none',
      text: 'Hi Mara, quick check before I dig in: do you have two or three order numbers where shipping was charged twice? And was it always on orders with a pre-order title in them?',
    }],
  }),
  hb109: task('Add a "charged twice" guard to the checkout total', { id: 'hb109', area: 'api', size: 'medium', confidence: 'medium', batch: 'batch-6', human: '2-3 hours', agent: '30-40 min' }),
  hb110: task('Restock badge also shows on the wishlist page', { id: 'hb110', batch: 'batch-7', needs: [] }),
  hb111: task('Gift cards: buy, email, redeem at checkout', {
    id: 'hb111', area: 'api', size: 'large', confidence: 'medium', implementable: 'partial', batch: 'batch-8', priority: 'high',
    human: '24-32 hours total across phases (Phase 1 about 12h; Phase 2 about 16h)', agent: '6-9 hours (Phase 1 3-4h), blocked on a payment account',
    needs: [
      { key: 'question', kind: 'question', title: 'Ask Mara how gift card balances should expire', to: 'Mara', blocking: true, delivered: 'description',
        text: 'Two things I need before building gift cards:\n\n1. Do balances expire? If so, after how long?\n2. Can a card be split across several orders?' },
      { key: 'dev-notes', kind: 'owed-write', title: 'Paste the gift card notes into the ticket', blocking: false,
        text: 'The provider write failed (daily quota). Paste the **Approach** section of the plan into the ticket description by hand.' },
    ],
  }),
  hb112: task('Staff picks carousel on the home page', { id: 'hb112', size: 'medium', batch: 'batch-9' }),
  hb113: task('Newsletter signup in the footer', { id: 'hb113', batch: 'batch-10', priority: 'low' }),
  hb114: task('Replace the old events banner', { id: 'hb114', type: 'copy-change', batch: 'batch-11', stale: true, stale_since: '2026-01-10', provider_status: 'closed' }),
  hb115: task('Events page reuses the new banner', { id: 'hb115', batch: 'batch-12' }),
  hb116: task('Loyalty points on the account page', { id: 'hb116', size: 'large', confidence: 'medium', batch: 'batch-13', human: '12-16 hours', agent: '3-4 hours' }),
  hb117: task('Reading lists: create and share', { id: 'hb117', size: 'large', batch: 'batch-14', human: '10-14 hours', agent: '2-3 hours' }),
  hb118: task('Reading lists: follow another reader', { id: 'hb118', size: 'medium', batch: 'batch-15', human: '6-8 hours', agent: '1-2 hours' }),
  hb119: task('Printable packing slip', { id: 'hb119', area: 'admin', batch: 'batch-16' }),
  hb120: task('Author pages list every edition', { id: 'hb120', size: 'medium', batch: 'batch-17' }),
  hb121: task('Basket badge shows the wrong count after removing an item', {
    id: 'hb121', type: 'bug', priority: 'urgent', implementable: 'no', already_fixed: true,
    note: 'Fixed by pull request #88, live since the last release. Ask Mara to re-check on her phone, then close.',
  }),
  hb122: task('Cart count is wrong after removing a book', { id: 'hb122', type: 'bug', duplicate_of: 'hb121' }),
  hb123: task('Renew the shop domain and update the DNS records', { id: 'hb123', area: 'manual', implementable: 'no', priority: 'high', human: 'unknown', agent: '' }),
  hb124: task(LONG_TITLE, { id: 'hb124', type: 'bug', confidence: 'medium', size: 'medium' }),
};

const committed = (n) => ({ status: 'committed', commit_shas: [String(n).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, 'a')] });

export const kitchenSink = {
  slug: 'sam',
  index: {
    schema_version: 2,
    last_triage: '2026-01-14',
    developer: 'Sam Rivera',
    developer_id: '000001',
    dev_head: 'abc1234de',
    summary_file: 'triage-sam-2026-01-14.md',
    tasks: ksTasks,
    batches: {
      'batch-1': { name: 'Shelf covers use the responsive image helper', tasks: ['hb101'], suggested_branch: 'fix/shelf-cover-sizes', depends_on: [] },
      'batch-2': { name: 'Back in stock badge', tasks: ['hb102'], suggested_branch: 'feat/restock-badge', depends_on: [] },
      'batch-3': { name: 'Admin CSV price import: bulk edit, row errors, template', tasks: ['hb103', 'hb104', 'hb105'], suggested_branch: 'feat/admin-price-import', depends_on: [],
        rationale: 'All three touch `PriceImportService`, so they cannot be split across worktrees.' },
      'batch-4': { name: 'Order email wraps long titles', tasks: ['hb106'], suggested_branch: 'fix/order-email-long-titles', depends_on: [] },
      'batch-5': { name: 'Search matches accented author names', tasks: ['hb107'], suggested_branch: 'fix/search-accents', depends_on: [] },
      'batch-6': { name: 'Double shipping charge: investigate, then guard the total', tasks: ['hb108', 'hb109'], suggested_branch: 'fix/double-shipping-charge', depends_on: [] },
      'batch-7': { name: 'Restock badge on the wishlist', tasks: ['hb110'], suggested_branch: 'feat/wishlist-restock-badge', depends_on: ['batch-2'] },
      'batch-8': { name: 'Gift cards, phase 1', tasks: ['hb111'], suggested_branch: 'feat/gift-cards', depends_on: ['batch-5', 'batch-6'] },
      'batch-9': { name: 'Staff picks carousel', tasks: ['hb112'], suggested_branch: 'feat/staff-picks', depends_on: [] },
      'batch-10': { name: 'Footer newsletter signup', tasks: ['hb113'], suggested_branch: 'feat/footer-newsletter', depends_on: [] },
      'batch-11': { name: 'Replace the events banner', tasks: ['hb114'], suggested_branch: 'chore/events-banner', depends_on: [] },
      'batch-12': { name: 'Events page uses the new banner', tasks: ['hb115'], suggested_branch: 'feat/events-page-banner', depends_on: ['batch-11'] },
      'batch-13': { name: 'Loyalty points', tasks: ['hb116'], suggested_branch: 'feat/loyalty-points', depends_on: ['batch-99'] },
      'batch-14': { name: 'Reading lists', tasks: ['hb117'], suggested_branch: 'feat/reading-lists', depends_on: ['batch-15'] },
      'batch-15': { name: 'Follow a reader', tasks: ['hb118'], suggested_branch: 'feat/follow-reader', depends_on: ['batch-14'] },
      'batch-16': { name: 'Printable packing slip', tasks: ['hb119'], suggested_branch: 'feat/packing-slip', depends_on: [] },
      'batch-17': { name: 'Author pages list every edition', tasks: ['hb120'], suggested_branch: 'feat/author-editions', depends_on: ['batch-17'] },
    },
    suggestions: [
      { key: 'refund-rounding', title: 'File a ticket: refunds round the wrong way', found_in: 'hb108',
        text: 'Partial refunds round half-up per line instead of on the order total. Found while reading the checkout total code. No ticket exists yet.' },
    ],
  },
  batchFiles: {
    'batch-1': { status: 'done', branch: 'fix/shelf-cover-sizes', pr_url: pr(101), tasks: { hb101: { ...committed(1), pr_url: pr(101) } } },
    'batch-2': { status: 'pr-created', branch: 'feat/restock-badge', pr_url: pr(102), tasks: { hb102: { ...committed(2), pr_url: pr(102) } } },
    'batch-3': { status: 'in-progress', branch: 'feat/admin-price-import', pr_url: null, tasks: { hb103: committed(3), hb104: { status: 'in-progress', commit_shas: [] }, hb105: { status: 'planned', commit_shas: [] } } },
    'batch-4': { status: 'pending', branch: null, pr_url: null, tasks: { hb106: { status: 'planned', commit_shas: [] } } },
    'batch-5': { status: 'pending', branch: null, pr_url: null, tasks: { hb107: { status: 'planned', commit_shas: [] } } },
    'batch-6': { status: 'pending', branch: null, pr_url: null, tasks: { hb108: { status: 'planned', commit_shas: [] }, hb109: { status: 'planned', commit_shas: [] } } },
    'batch-7': { status: 'pending', branch: null, pr_url: null, tasks: { hb110: { status: 'planned', commit_shas: [] } } },
    'batch-8': { status: 'pending', branch: null, pr_url: null, tasks: { hb111: { status: 'planned', commit_shas: [] } } },
    'batch-9': { status: 'pending', branch: null, pr_url: null, tasks: { hb112: { status: 'planned', commit_shas: [] } } },
    'batch-10': { status: 'in-progress', branch: 'feat/footer-newsletter', pr_url: null, tasks: { hb113: { status: 'in-progress', commit_shas: [] } } },
    'batch-11': { status: 'stale', branch: null, pr_url: null, tasks: { hb114: { status: 'stale', commit_shas: [] } } },
    'batch-12': { status: 'pending', branch: null, pr_url: null, tasks: { hb115: { status: 'planned', commit_shas: [] } } },
    'batch-13': { status: 'pending', branch: null, pr_url: null, tasks: { hb116: { status: 'planned', commit_shas: [] } } },
    'batch-14': { status: 'pending', branch: null, pr_url: null, tasks: { hb117: { status: 'planned', commit_shas: [] } } },
    'batch-15': { status: 'pending', branch: null, pr_url: null, tasks: { hb118: { status: 'planned', commit_shas: [] } } },
    'batch-16': '{ "status": "pend',
    'batch-17': { status: 'reviewing', branch: null, pr_url: null, tasks: { hb120: { status: 'planned', commit_shas: [] } } },
  },
  batchFileAges: { 'batch-3': 4 * MIN },
  locks: { 'batch-2': 26 * HOUR, 'batch-3': 50 * MIN, 'batch-4': 2 * MIN, 'batch-9': 3 * HOUR },
  plans: {
    ...Object.fromEntries(Object.keys(ksTasks).filter((id) => !['hb122', 'hb120'].includes(id)).map((id) => [id, plan(ksTasks[id].name)])),
    hb101: HOSTILE_PLAN,
    hb112: plan(ksTasks.hb112.name, { question: 'Hi Mara, should the carousel rotate on its own, or only when someone taps the arrows?' }),
  },
  attachments: { hb101: ['before.png', 'after.png', 'diagram.svg', 'notes.exe'], hb108: ['receipt.png'] },
  summary: {
    name: 'triage-sam-2026-01-14.md',
    markdown: '# Triage summary\n\nTriaged against `abc1234de`. Two tasks carried over.\n\n## Batches (claim in this order)\n\n### Batch 1: Shelf covers\n\n- [ ] Shelf covers (hb101, urgent, small/high)\n\n> Smallest urgent fix first.\n\n## Stats\n\n- **Tasks:** 24\n',
  },
  ticks: {
    schema_version: 1, slug: 'sam', cycle: '2026-01-14', updated_at: '2026-01-14T10:00:00.000Z',
    items: {
      'suggestion:cycle:refund-rounding': { resolution: 'filed', at: '2026-01-14T10:00:00.000Z', fingerprint: 'stale-on-purpose', title: 'old title', note: '' },
    },
  },
};

// ---------------------------------------------------------------------------
// all-pending: a cycle straight after triage, schema v1 (no `needs`)
// ---------------------------------------------------------------------------

const apTasks = {};
const apBatches = {};
const apFiles = {};
const apDeps = { 11: ['batch-1', 'batch-2', 'batch-5'], 12: ['batch-3'] };
for (let n = 1; n <= 12; n++) {
  const id = `ap${100 + n}`;
  apTasks[id] = task(`All-pending task ${n}`, { id, batch: `batch-${n}`, confidence: n === 10 ? 'low' : 'high' });
  apBatches[`batch-${n}`] = { name: `All-pending batch ${n}`, tasks: [id], suggested_branch: `feat/all-pending-${n}`, depends_on: apDeps[n] ?? [] };
  apFiles[`batch-${n}`] = { status: 'pending', branch: null, pr_url: null, tasks: { [id]: { status: 'planned', commit_shas: [] } } };
}
apTasks.ap200 = task('Already fixed, not batched', { id: 'ap200', already_fixed: true, note: 'Fixed by an earlier pull request. Close after the next release.' });

export const allPending = {
  slug: 'sam',
  index: { last_triage: '2026-01-20', developer: 'Sam Rivera', developer_id: '000001', tasks: apTasks, batches: apBatches },
  batchFiles: apFiles,
  plans: { ap110: plan('All-pending task 10', { question: 'Which report is this about?' }), ap101: plan('All-pending task 1') },
};

// ---------------------------------------------------------------------------
// archive-shape: what a finished, hand-archived cycle looks like on disk
// ---------------------------------------------------------------------------

const arTasks = {};
const arBatches = {};
for (let n = 1; n <= 6; n++) {
  const id = `ar${100 + n}`;
  arTasks[id] = task(`Archived task ${n}`, { id, batch: `batch-${n}`, ...(n <= 3 ? { stale: true, stale_since: '2025-12-01', provider_status: 'ready to test' } : {}) });
  arBatches[`batch-${n}`] = { name: `Archived batch ${n}`, tasks: [id], suggested_branch: `feat/archived-${n}`, depends_on: n === 6 ? ['batch-5'] : [] };
}
const shipped = (n) => ({ status: 'pr-created', branch: `feat/archived-${n}`, pr_url: pr(200 + n), tasks: { [`ar${100 + n}`]: { ...committed(n), pr_url: pr(200 + n) } } });

export const archiveShape = {
  slug: 'sam',
  // Hand-renamed on archive; the reader must still find it.
  indexFile: 'state.sam.2025-11-20-plus-draft.json',
  index: { last_triage: '2025-12-01', developer: 'Sam Rivera', developer_id: '000001', tasks: arTasks, batches: arBatches },
  // Only the first four batches ever got a file.
  batchFiles: { 'batch-1': shipped(1), 'batch-2': shipped(2), 'batch-3': shipped(3), 'batch-4': { status: 'pending', branch: null, pr_url: null, tasks: { ar104: { status: 'planned', commit_shas: [] } } } },
  // Locks are never removed on success: these are normal, not stale.
  locks: { 'batch-1': 40 * 24 * HOUR, 'batch-2': 40 * 24 * HOUR, 'batch-3': 39 * 24 * HOUR },
  summary: { name: 'triage-sam-2025-11-20.md', markdown: '# Older summary\n\nDated before `last_triage` on purpose.\n' },
};

// ---------------------------------------------------------------------------
// questions: schema v3, one need per question, answers recorded against some
// ---------------------------------------------------------------------------

const ask = (key, title, text, extra = {}) => ({ key, kind: 'question', title, text, to: 'Mara', blocking: true, ...extra });

const qsNeeds = {
  qs101: [
    ask('q-cover-ratio', 'Ask Mara which cover ratio the shelf should use', 'Hi Mara, the new shelf can crop covers two ways. Which one do you want?', { options: ['Portrait, 2:3', 'Square'] }),
    ask('q-sold-out', 'Ask Mara whether sold-out titles stay on the shelf', 'Should a title that is sold out stay on the shelf with a badge, or disappear until it is back?'),
    ask('q-badge-colour', 'Ask Mara about the badge colour', 'Any preference for the badge colour? I will use the brand green otherwise.', { blocking: false }),
  ],
  qs103: [ask('q-points-expiry', 'Ask Mara when loyalty points expire', 'Do loyalty points expire? If so, after how long?')],
  qs105: [ask('q-slip-logo', 'Ask Mara which logo goes on the packing slip', 'Which logo should the packing slip carry: the shop mark or the full wordmark?')],
  qs106: [ask('q-author-order', 'Ask Mara how editions are ordered', 'Should editions be listed newest first, or by format?')],
};

const qsTasks = {
  qs101: task('Shelf: crop covers and handle sold-out titles', { id: 'qs101', batch: 'batch-1', priority: 'high', confidence: 'medium', needs: qsNeeds.qs101 }),
  qs102: task('Footer: add the opening hours', { id: 'qs102', batch: 'batch-2', type: 'copy-change', needs: [] }),
  qs103: task('Loyalty points on the account page', { id: 'qs103', batch: 'batch-3', size: 'medium', confidence: 'low', needs: qsNeeds.qs103 }),
  qs104: task('Search: match accented author names', { id: 'qs104', batch: 'batch-4', type: 'bug', needs: [] }),
  qs105: task('Printable packing slip', { id: 'qs105', batch: 'batch-5', area: 'admin', needs: qsNeeds.qs105 }),
  qs106: task('Author pages list every edition', { id: 'qs106', batch: 'batch-6', needs: qsNeeds.qs106 }),
};

const answeredEntry = (taskId, need, { resolution = 'answered', answers = [], note = '', title = need.title, text = need.text } = {}) => ({
  taskId, key: need.key, resolution, fingerprint: fingerprint(title, text, need.options ?? null), title, text, note, at: '2026-02-03T09:30:00.000Z',
  answers: answers.map((a, i) => ({
    id: `seed${taskId}${i}`, at: '2026-02-03T09:30:00.000Z', source: 'Mara, by phone, 3 Feb', via: 'web', idempotencyKey: null,
    questionFingerprint: fingerprint(title, text, need.options ?? null), questionTitle: title, questionText: text, ...a,
  })),
});

export const questions = {
  slug: 'sam',
  index: {
    schema_version: 3,
    last_triage: '2026-02-02',
    developer: 'Sam Rivera',
    developer_id: '000001',
    dev_head: 'def5678ab',
    tasks: qsTasks,
    batches: {
      'batch-1': { name: 'Shelf covers and sold-out titles', tasks: ['qs101'], suggested_branch: 'feat/shelf-covers', depends_on: [] },
      'batch-2': { name: 'Opening hours in the footer', tasks: ['qs102'], suggested_branch: 'chore/footer-hours', depends_on: [] },
      'batch-3': { name: 'Loyalty points', tasks: ['qs103'], suggested_branch: 'feat/loyalty-points', depends_on: ['batch-1'] },
      'batch-4': { name: 'Accented author search', tasks: ['qs104'], suggested_branch: 'fix/search-accents', depends_on: [] },
      'batch-5': { name: 'Packing slip', tasks: ['qs105'], suggested_branch: 'feat/packing-slip', depends_on: [] },
      'batch-6': { name: 'Author editions', tasks: ['qs106'], suggested_branch: 'feat/author-editions', depends_on: [] },
    },
    suggestions: [],
  },
  batchFiles: Object.fromEntries(Object.entries(qsTasks).map(([id, t]) => [t.batch, { status: 'pending', branch: null, pr_url: null, tasks: { [id]: { status: 'planned', commit_shas: [] } } }])),
  plans: Object.fromEntries(Object.keys(qsTasks).map((id) => [id, plan(qsTasks[id].name)])),
  answers: {
    schema_version: 1,
    updated_at: '2026-02-03T09:30:00.000Z',
    items: {
      // Answered: batch-5 is claimable.
      'question:qs105:q-slip-logo': answeredEntry('qs105', qsNeeds.qs105[0], { answers: [{ body: 'Use the **full wordmark**, top left.' }] }),
      // Answered, then triage reworded the question: shows as changed and blocks again.
      'question:qs106:q-author-order': answeredEntry('qs106', qsNeeds.qs106[0], { title: 'Ask Mara about edition order', text: 'How should editions be ordered?', answers: [{ body: 'Newest first.' }] }),
      // Sent, no answer yet.
      'question:qs101:q-sold-out': answeredEntry('qs101', qsNeeds.qs101[1], { resolution: 'sent' }),
      // A question triage no longer asks; the answer is still real client input.
      'question:qs102:q-hours-format': { taskId: 'qs102', key: 'q-hours-format', resolution: 'answered', fingerprint: 'gone', title: 'Ask Mara how to write the hours', text: '24-hour or am/pm?', note: '', at: '2026-01-20T10:00:00.000Z',
        answers: [{ id: 'seedqs1020', at: '2026-01-20T10:00:00.000Z', body: 'am/pm, please.', source: 'Mara, email', via: 'web', idempotencyKey: null, questionFingerprint: 'gone', questionTitle: 'Ask Mara how to write the hours', questionText: '24-hour or am/pm?' }] },
    },
  },
};

// ---------------------------------------------------------------------------
// shuffled: ids and names whose order depends on who sorts them. Object keys
// here are deliberately not alphabetical, one is integer-like, and the
// attachment names sort differently by locale and by byte value. A store that
// reorders keys or re-sorts names cannot rebuild the same model from this.
// `enrichment` is not materialised: tests hand it to the model and the payload.
// ---------------------------------------------------------------------------

const shTasks = {
  zz9: task('Hotfix: basket total rounds the wrong way', { id: 'zz9', type: 'bug', priority: 'urgent', batch: 'hotfix-b', needs: [ask('q-rounding', 'Ask Mara which way half pennies round', 'Half a penny: up, down, or to even?')] }),
  Aa1: task('Hotfix follow-up: show the rounding rule on the receipt', { id: 'Aa1', batch: 'hotfix-A', needs: [] }),
  b10: task('Bundle page: ten-title bundles', { id: 'b10', batch: 'batch-10', size: 'medium', needs: [] }),
  b2: task('Bundle page: two-title bundles', { id: 'b2', batch: 'batch-2', needs: [] }),
  10: task('Bundle page: copy for the banner', { id: '10', type: 'copy-change', batch: 'batch-10', needs: [] }),
};

export const shuffled = {
  slug: 'sam',
  index: {
    schema_version: 3,
    last_triage: '2026-03-01',
    developer: 'Sam Rivera',
    developer_id: '000001',
    dev_head: '0a1b2c3d4',
    tasks: shTasks,
    batches: {
      'hotfix-b': { name: 'Basket rounding', tasks: ['zz9'], suggested_branch: 'fix/hotfix-b', depends_on: [] },
      'hotfix-A': { name: 'Rounding rule on the receipt', tasks: ['Aa1'], suggested_branch: 'feat/hotfix-a', depends_on: ['hotfix-b'] },
      'batch-10': { name: 'Bundles of ten, and the banner copy', tasks: ['b10', '10'], suggested_branch: 'feat/bundles-ten', depends_on: ['batch-2'] },
      'batch-2': { name: 'Bundles of two', tasks: ['b2'], suggested_branch: 'feat/bundles-two', depends_on: [] },
    },
    suggestions: [],
  },
  batchFiles: {
    'hotfix-b': { status: 'pr-created', branch: 'fix/hotfix-b', pr_url: pr(301), tasks: { zz9: { ...committed(1), pr_url: pr(301) } } },
    'batch-2': { status: 'pending', branch: null, pr_url: null, tasks: { b2: { status: 'planned', commit_shas: [] } } },
  },
  locks: { 'hotfix-b': 3 * HOUR },
  plans: Object.fromEntries(Object.keys(shTasks).map((id) => [id, plan(shTasks[id].name)])),
  attachments: { zz9: ['B.png', 'a.png', '10.png'] },
  summary: { name: 'triage-sam-2026-03-01.md', markdown: '# Triage summary\n\nFive tasks, four batches.\n' },
  enrichment: {
    git: 'ok',
    gh: 'ok',
    asOf: '2026-03-02T08:00:00.000Z',
    prs: { [pr(301)]: { state: 'merged', isDraft: false, reviewDecision: 'APPROVED', checks: 'passing', mergedAt: '2026-03-02T07:00:00.000Z', asOf: '2026-03-02T08:00:00.000Z' } },
    worktrees: [{ path: '/home/sam/worktrees/hotfix-b', branch: 'fix/hotfix-b' }],
  },
};

export const specs = { 'kitchen-sink': { ...kitchenSink, archives: { '2025-12-01': archiveShape } }, 'all-pending': allPending, 'archive-shape': archiveShape, questions, shuffled };
