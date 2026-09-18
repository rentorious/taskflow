// Taskflow report client. One file on purpose: `--snapshot` inlines it into a
// single HTML document, and module imports do not resolve from file://.
//
// Trust boundary: strings from the model are inserted with textContent. The only
// innerHTML sinks take fields the server rendered through its escape-first
// markdown renderer (names ending in `Html`, and plan section `html`).

const $ = (id) => document.getElementById(id);

const embedded = document.getElementById('snapshot-data');
const SNAPSHOT = embedded ? JSON.parse(embedded.textContent) : null;

const state = {
  model: null,
  cycles: [],
  cycle: 'live',
  sel: null, // {type: 'batch'|'task'|'item', id}
  filters: {}, // facetKey -> Set(values)
  query: '',
  filtersOpen: false,
  showHandled: false,
  details: new Map(), // `${cycle}:${taskId}:${mtime}` -> task detail
  sections: new Map(), // `${taskId}:${slug}` -> open? (only what the user toggled)
  changed: new Set(),
  detailKey: null,
  detailStale: false, // a model arrived while an answer was being typed; repaint on blur
  drafts: new Map(), // itemId -> {body, source, key, sent}
  dropping: null, // itemId whose "why drop it" input is open
  reanswering: new Set(), // settled questions whose composer was opened on purpose
  live: SNAPSHOT ? 'snapshot' : 'connecting',
};

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value; // server-rendered, escape-first markdown only
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const replace = (node, ...children) => node.replaceChildren(...children.flat(Infinity).filter(Boolean));

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const RESOLUTION = {
  sent: ['Mark sent', 'Sent'],
  answered: ['Mark answered', 'Answered'],
  dropped: ['Drop', 'Dropped'],
  done: ['Mark done', 'Done'],
  verified: ['Mark verified', 'Verified'],
  closed: ['Mark closed', 'Closed'],
  filed: ['Mark filed', 'Filed'],
  dismissed: ['Dismiss', 'Dismissed'],
};

const KIND = {
  question: { glyph: '?', copy: 'Copy question' },
  'owed-write': { glyph: '✎', copy: 'Copy text' },
  todo: { glyph: '•', copy: 'Copy text' },
  'verify-close': { glyph: '✓', copy: 'Copy note' },
  suggestion: { glyph: '+', copy: 'Copy text' },
  'stale-lock': { glyph: '!', trouble: true },
  'orphaned-claim': { glyph: '!', trouble: true },
  'dep-problem': { glyph: '!', trouble: true },
  'pr-closed': { glyph: '!', trouble: true },
  'pr-attention': { glyph: '!', trouble: true },
  'leftover-worktree': { glyph: '–' },
};

const EMPTY_LANE = {
  'needs-you': 'Nothing is waiting on you.',
  ready: 'Nothing is ready to claim.',
  'in-flight': 'No session is working on a batch. Start one with /taskflow:implement.',
  'pr-open': 'No pull requests are open.',
  blocked: 'Nothing is blocked.',
  done: 'Nothing has shipped yet.',
};

const LANE_HINT = {
  'needs-you': 'Questions, checks and fixes that wait on you, not on code',
  ready: '/taskflow:implement claims these from the top',
};

const TASK_STATUS = { committed: ['✓', 'Committed'], 'in-progress': ['●', 'In progress'], planned: ['○', 'Planned'], stale: ['×', 'Left to do in the provider'] };
const DISPOSITION = { 'already-fixed': 'Already fixed', duplicate: 'Duplicate', manual: 'Manual', unassigned: 'Not batched', batched: '' };

function list(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function ago(iso) {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.round(hours / 24), 'day')} ago`;
}

function ageWords(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return plural(Math.max(1, minutes), 'minute');
  const hours = Math.round(minutes / 60);
  return hours < 48 ? plural(hours, 'hour') : plural(Math.round(hours / 24), 'day');
}

function duration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 10 || rest === 0) return `${Math.round(minutes / 60)} h`;
  return `${hours} h ${rest} min`;
}

function range(estimate) {
  if (!estimate || estimate.count === 0 || estimate.count === estimate.unparsed) return null;
  const text = estimate.minMinutes === estimate.maxMinutes ? duration(estimate.minMinutes) : `${duration(estimate.minMinutes)} to ${duration(estimate.maxMinutes)}`;
  const notes = [];
  if (estimate.unparsed) notes.push(`${plural(estimate.unparsed, 'estimate')} could not be read`);
  if (estimate.caveats) notes.push(`${estimate.caveats} with caveats`);
  return notes.length ? `${text} (${notes.join(', ')})` : text;
}

function longDate(text) {
  const date = new Date(`${text}T12:00:00`);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

const batchLabel = (b) => (b.number !== null ? `batch ${b.number}` : b.key);
const batchRefs = (keys) => list(keys.map((k) => String(state.model.batches[k]?.number ?? k)));

/** The one-line, plain-language state of a batch. */
function batchNote(b) {
  const m = state.model;
  switch (b.lane) {
    case 'ready': {
      const order = b.claimOrder === 1 ? 'Next to be claimed' : `Claim order ${b.claimOrder}`;
      return b.stackOn ? `${order}, stacks on batch ${m.batches[b.stackOn.key]?.number ?? b.stackOn.key}` : order;
    }
    case 'blocked':
      if (b.laneReason === 'stale-lock') return `Locked ${ageWords(b.lockAgeMs)} ago and never started`;
      if (b.laneReason === 'dep-stale') return `Waits on ${batchRefs(b.blockedBy)}, which went stale`;
      if (b.laneReason === 'dep-missing') return 'Waits on a batch that does not exist';
      if (b.laneReason === 'dep-cycle') return `Stuck in a dependency loop with ${batchRefs(b.blockedBy)}`;
      if (b.laneReason === 'waiting-on-answers') return `Waits on ${b.blockingQuestions} answer${b.blockingQuestions === 1 ? '' : 's'}`;
      return `Waits on ${batchRefs(b.blockedBy)}`;
    case 'in-flight': {
      const done = `${b.progress.committed} of ${b.progress.total} committed`;
      if (b.laneReason === 'claiming') return 'A session is claiming this now';
      if (b.laneReason === 'orphaned') return `${done}, but nothing holds the lock`;
      if (b.laneReason === 'quiet') return `${done}, quiet since ${ago(b.lastActivityAt)}`;
      return done;
    }
    case 'pr-open': {
      const label = b.pr?.number ? `Pull request #${b.pr.number}` : 'Pull request';
      const bits = [];
      if (b.pr?.isDraft) bits.push('draft');
      if (b.pr?.checks === 'failing') bits.push('checks failing');
      if (b.pr?.checks === 'passing') bits.push('checks passing');
      if (b.pr?.reviewDecision === 'CHANGES_REQUESTED') bits.push('changes requested');
      if (b.pr?.reviewDecision === 'APPROVED') bits.push('approved');
      return bits.length ? `${label} open, ${list(bits)}` : `${label} open`;
    }
    case 'shipped':
      return b.pr?.state === 'merged' ? `Merged${b.pr.mergedAt ? ` ${ago(b.pr.mergedAt)}` : ''}` : 'Done';
    default:
      if (b.laneReason === 'pr-closed') return 'Pull request closed without merging';
      if (b.laneReason === 'tasks-left-todo') return 'Every task left to do in the provider';
      return 'Went stale';
  }
}

const isTrouble = (b) => ['stale-lock', 'orphaned', 'dep-stale', 'dep-missing', 'dep-cycle', 'pr-closed'].includes(b.laneReason) ||
  b.pr?.checks === 'failing' || b.flags.includes('batch-unreadable');

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const withCycle = (path) => (state.cycle === 'live' ? path : `${path}${path.includes('?') ? '&' : '?'}cycle=${encodeURIComponent(state.cycle)}`);

async function getJson(path) {
  const res = await fetch(withCycle(path), { cache: 'no-store' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
  return res.json();
}

async function loadModel({ announce = false } = {}) {
  let next;
  if (SNAPSHOT) next = SNAPSHOT.model;
  else next = await getJson('api/model');
  if (state.model && next.version === state.model.version) return;

  if (state.model && announce) {
    state.changed = new Set();
    const sig = (b) => b && [b.lane, b.laneReason, b.progress.committed, b.progress.inProgress, b.pr?.state, b.pr?.checks].join('|');
    for (const [key, b] of Object.entries(next.batches)) if (sig(b) !== sig(state.model.batches[key])) state.changed.add(key);
    for (const [id, item] of Object.entries(next.inbox)) if (state.model.inbox[id]?.state !== item.state) state.changed.add(id);
  }
  state.model = next;
  render();
}

async function loadTaskDetail(id) {
  const task = state.model.tasks[id];
  const key = `${state.cycle}:${id}:${task?.plan.mtimeMs ?? 0}`;
  if (!state.details.has(key)) {
    state.details.set(key, SNAPSHOT ? Promise.resolve(SNAPSHOT.tasks[id]) : getJson(`api/task/${encodeURIComponent(id)}`));
  }
  return state.details.get(key);
}

// ---------------------------------------------------------------------------
// URL state — selection and filters live in the hash, so a reload keeps them.
// ---------------------------------------------------------------------------

function readHash() {
  const [path = '', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [type, ...rest] = path.split('/');
  const id = decodeURIComponent(rest.join('/'));
  const params = new URLSearchParams(query);

  state.sel = ['batch', 'task', 'item'].includes(type) && id ? { type, id } : null;
  state.cycle = SNAPSHOT ? SNAPSHOT.model.cycle.id : params.get('cycle') || 'live';
  state.query = params.get('q') || '';
  state.filters = {};
  for (const [key, value] of params) {
    if (key.startsWith('f.') && value) state.filters[key.slice(2)] = new Set(value.split(','));
  }
}

function writeHash({ push = false } = {}) {
  const params = new URLSearchParams();
  if (state.cycle !== 'live' && !SNAPSHOT) params.set('cycle', state.cycle);
  if (state.query) params.set('q', state.query);
  for (const [key, values] of Object.entries(state.filters)) if (values.size) params.set(`f.${key}`, [...values].join(','));
  const path = state.sel ? `/${state.sel.type}/${encodeURIComponent(state.sel.id)}` : '/';
  const query = params.toString();
  const next = `#${path}${query ? `?${query}` : ''}`;
  if (next === location.hash) return;
  if (push) history.pushState(null, '', next);
  else history.replaceState(null, '', next);
}

function select(sel, { focusDetail = false, scroll = true } = {}) {
  state.sel = sel;
  writeHash({ push: true });
  document.body.dataset.pane = sel && focusDetail ? 'detail' : 'queue';
  markCurrent(scroll);
  renderDetail();
  if (focusDetail) $('detail').focus();
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const activeFacets = () => Object.entries(state.filters).filter(([, values]) => values.size);
const isFiltering = () => activeFacets().length > 0 || state.query.trim() !== '';

function matchesQuery(task) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const batch = task.batch ? state.model.batches[task.batch] : null;
  return [task.name, task.id, task.area, task.type, batch?.name, batch?.key, batch?.branch, batch?.suggestedBranch]
    .some((text) => text && String(text).toLowerCase().includes(q));
}

function taskMatches(task, except = null) {
  for (const [key, values] of activeFacets()) {
    if (key !== except && !values.has(task[key])) return false;
  }
  return matchesQuery(task);
}

function batchVisible(b) {
  if (!isFiltering()) return true;
  return b.taskIds.some((id) => taskMatches(state.model.tasks[id]));
}

function itemVisible(item) {
  if (!isFiltering()) return true;
  if (item.subject.type === 'task') return taskMatches(state.model.tasks[item.subject.id]);
  if (item.subject.type === 'batch') return batchVisible(state.model.batches[item.subject.id]);
  return activeFacets().length === 0 && item.title.toLowerCase().includes(state.query.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Clipboard and toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(message, ms = 1800) {
  const el = $('toast');
  el.textContent = message;
  el.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.show = 'false'; }, ms);
}

async function copy(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; file:// snapshots fall back to this.
    const area = h('textarea', { class: 'visually-hidden' });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(done);
}

const copyButton = (label, text, done, cls = 'btn') =>
  h('button', { type: 'button', class: cls, onclick: (event) => { event.stopPropagation(); copy(text, done); } }, label);

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

const canTick = () => !SNAPSHOT && !state.model.cycle.readOnly;

/** POST one change to an inbox item. Returns true when it was saved. Always reloads the model. */
async function post(path, payload, done) {
  let ok = false;
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    ok = res.ok;
    if (res.status === 403) toast('This cycle is archived. Nothing can be changed here.');
    else if (!res.ok) toast((await res.json().catch(() => ({}))).error || (res.status === 409 ? 'That item changed. Reloaded it.' : 'Could not save that.'), 3200);
    else toast(done);
  } catch {
    toast('The report server is not answering. Nothing was saved.', 3200);
  }
  await loadModel();
  return ok;
}

const tick = (item, resolution, note = '') =>
  post('api/inbox', { id: item.id, resolution, fingerprint: item.fingerprint, note }, resolution ? RESOLUTION[resolution][1] : 'Reopened');

// -- answers -----------------------------------------------------------------

const DRAFTS_KEY = 'taskflow-drafts';
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// Drafts outlive a reload: a phone evicts background tabs mid-sentence. Not in a
// snapshot, though — every file:// page shares one storage origin.
function loadDrafts() {
  if (SNAPSHOT) return;
  try {
    for (const [id, draft] of Object.entries(JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}'))) {
      if (draft && typeof draft.body === 'string') state.drafts.set(id, { body: draft.body, source: String(draft.source ?? ''), key: draft.key || newKey(), sent: false });
    }
  } catch {
    // Storage is blocked or the value is junk: drafts just stay in memory.
  }
}

function persistDrafts() {
  if (SNAPSHOT) return;
  try {
    const out = {};
    for (const [id, d] of state.drafts) if (d.body || d.source) out[id] = { body: d.body, source: d.source, key: d.key };
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(out));
  } catch {
    // See loadDrafts.
  }
}

function draftOf(id) {
  if (!state.drafts.has(id)) state.drafts.set(id, { body: '', source: '', key: newKey(), sent: false });
  return state.drafts.get(id);
}

function editDraft(id, field, value) {
  const draft = draftOf(id);
  draft[field] = value;
  // A retry of the same text must not double up; different text after a failed try is a new answer.
  if (draft.sent) { draft.key = newKey(); draft.sent = false; }
  persistDrafts();
}

async function saveAnswer(item, body, source) {
  const draft = draftOf(item.id);
  draft.sent = true;
  document.activeElement?.blur(); // so the repaint that follows is not held back for the typist
  const saved = await post('api/answer', {
    id: item.id, fingerprint: item.fingerprint, body, source,
    idempotencyKey: draft.key,
    previousAnswerId: item.answers?.at(-1)?.id ?? null,
  }, 'Answer saved');
  if (saved) { state.drafts.delete(item.id); state.reanswering.delete(item.id); persistDrafts(); renderDetail(); }
}

const confirmAnswer = (item) => post('api/answer/confirm', { id: item.id, fingerprint: item.fingerprint }, 'Kept');

/** Item ids contain ":", so find a composer by comparing dataset values, never by building a selector. */
function focusComposer(id) {
  const composer = [...$('detail').querySelectorAll('.composer')].find((el) => el.dataset.itemId === id);
  const field = composer?.querySelector('textarea');
  if (!field) return;
  field.focus({ preventScroll: true });
  composer.scrollIntoView({ block: 'nearest' });
}

function answerQuestion(item) {
  select({ type: 'item', id: item.id }, { focusDetail: false });
  if (narrow()) document.body.dataset.pane = 'detail';
  requestAnimationFrame(() => focusComposer(item.id));
}

// Only a text field counts. A focused button in the composer is not typing, and
// treating it as such would hold back the repaint that shows what the button did.
function isTypingAnswer() {
  const el = document.activeElement;
  return Boolean(el && /^(TEXTAREA|INPUT)$/.test(el.tagName) && el.closest('.composer'));
}

/** The resolutions still ahead of an item, in order. */
function nextSteps(item) {
  if (!item.tickable || !canTick()) return [];
  if (item.state === 'handled' || item.state === 'changed') return [];
  const at = item.resolution ? item.resolutions.indexOf(item.resolution) : -1;
  let steps = item.resolutions.slice(at + 1);
  // Already delivered through the ticket description: "sent" has happened.
  if (!item.resolution && item.state === 'waiting') steps = steps.filter((r) => r !== 'sent');
  return steps;
}

function itemMeta(item) {
  const m = state.model;
  const where = item.subject.batch && m.batches[item.subject.batch]
    ? `For ${batchLabel(m.batches[item.subject.batch])}`
    : item.subject.type === 'cycle' ? 'For this cycle' : 'Not batched';
  const who = item.to ? `, to ${item.to}` : '';
  const blocking = item.blocking && item.state !== 'handled' ? ' Implement will not start this batch until it is answered or dropped.' : '';

  if (item.state === 'changed' && item.kind === 'question') {
    const held = item.blocking ? ' It holds the batch until you confirm it still applies.' : '';
    return `You marked this ${RESOLUTION[item.resolution][1].toLowerCase()} ${ago(item.resolvedAt)}, but the question was reworded since.${held}`;
  }
  if (item.state === 'changed') return `You marked this ${RESOLUTION[item.resolution][1].toLowerCase()} ${ago(item.resolvedAt)}, but the text has changed since.`;
  if (item.state === 'handled') return `${RESOLUTION[item.resolution][1]} ${ago(item.resolvedAt)}. ${where}.`;
  if (item.state === 'waiting') {
    const since = item.resolution ? `${RESOLUTION[item.resolution][1]} ${ago(item.resolvedAt)}.` : 'Already in the ticket description.';
    const waiting = item.kind === 'question' ? ` Waiting on ${item.to || 'a reply'}.` : ' Not closed yet.';
    return `${since}${waiting} ${where}.`;
  }
  return `${where}${who}.${blocking}`;
}

function questionActions(item, { all }) {
  const stop = (fn) => (event) => { event.stopPropagation(); fn(); };
  const button = (label, fn, cls = 'btn') => h('button', { type: 'button', class: cls, onclick: stop(fn) }, label);
  const buttons = [];
  if (item.copyText && item.state !== 'handled') buttons.push(copyButton(KIND.question.copy, item.copyText, 'Copied'));
  if (!canTick()) return buttons;

  // In the queue there is one next move, and for a question it is always the same.
  if (!all) {
    if (item.state === 'changed') buttons.push(button('Check the answer', () => answerQuestion(item)));
    else if (item.state !== 'handled') buttons.push(button('Answer', () => answerQuestion(item)));
    return buttons;
  }

  if (item.state === 'changed') buttons.push(button(item.resolution === 'answered' ? 'Answer still applies' : 'Still applies', () => confirmAnswer(item), 'btn btn-primary'));
  if (item.state === 'open') buttons.push(button(RESOLUTION.sent[0], () => tick(item, 'sent')));
  if (item.state === 'open' || item.state === 'waiting') buttons.push(button(RESOLUTION.dropped[0], () => { state.dropping = state.dropping === item.id ? null : item.id; renderDetail(); }));
  if (item.resolution) buttons.push(button('Reopen', () => tick(item, null)));
  return buttons;
}

function itemActions(item, { all = false } = {}) {
  if (item.kind === 'question') return questionActions(item, { all });
  const kind = KIND[item.kind] ?? KIND.todo;
  const buttons = [];
  if (item.copyText && item.state !== 'handled') buttons.push(copyButton(kind.copy, item.copyText, 'Copied'));
  if (item.command) buttons.push(copyButton('Copy command', item.command, 'Command copied'));

  const steps = nextSteps(item);
  (all ? steps : steps.slice(0, 1)).forEach((resolution, i) => {
    buttons.push(h('button', {
      type: 'button', class: i === 0 && all ? 'btn btn-primary' : 'btn',
      onclick: (event) => { event.stopPropagation(); tick(item, resolution); },
    }, RESOLUTION[resolution][0]));
  });

  if (canTick() && item.tickable && item.state === 'changed') {
    buttons.push(h('button', { type: 'button', class: all ? 'btn btn-primary' : 'btn', onclick: (e) => { e.stopPropagation(); tick(item, item.resolution); } }, `Keep as ${RESOLUTION[item.resolution][1].toLowerCase()}`));
  }
  if (canTick() && item.tickable && (item.state === 'handled' || item.state === 'changed' || (item.resolution && all))) {
    buttons.push(h('button', { type: 'button', class: 'btn', onclick: (e) => { e.stopPropagation(); tick(item, null); } }, 'Reopen'));
  }
  return buttons;
}

function slip(item, { inDetail = false } = {}) {
  const kind = KIND[item.kind] ?? KIND.todo;
  // Only queue rows take part in j/k navigation; the copy inside the detail pane does not.
  const nav = inDetail ? {} : { nav: 'item', id: item.id, changed: state.changed.has(item.id) };
  return h('article', {
    class: 'slip',
    dataset: { state: item.state, severity: kind.trouble ? 'trouble' : 'normal', place: inDetail ? 'detail' : 'queue', ...nav },
    tabindex: inDetail ? null : '0',
    onclick: inDetail ? null : () => select({ type: 'item', id: item.id }, { focusDetail: narrow() }),
  },
    h('div', { class: 'slip-tab', 'aria-hidden': 'true' }, kind.glyph),
    h('div', { class: 'slip-body' },
      h('h3', { class: 'slip-title' }, item.title),
      // Derived items explain themselves; their text is rendered markdown (it names commands).
      item.origin === 'derived' ? h('div', { class: 'slip-meta', html: item.bodyHtml }) : h('p', { class: 'slip-meta' }, itemMeta(item)),
      inDetail && item.bodyHtml && item.origin !== 'derived' ? h('div', { class: 'prose', html: item.bodyHtml }) : null,
      inDetail && item.command ? h('p', { class: 'slip-meta' }, h('code', null, item.command)) : null,
      inDetail && item.kind === 'question' && item.resolution === 'dropped' && item.userNote ? h('p', { class: 'slip-meta' }, `Dropped because: ${item.userNote}`) : null,
      inDetail && item.kind === 'question' ? answerBlock(item) : null,
    ),
    h('div', { class: 'slip-actions' }, itemActions(item, { all: inDetail })),
    inDetail && item.kind === 'question' && canTick() ? composer(item) : null,
  );
}

const answerLine = (a) => [a.source, a.at ? `recorded ${ago(a.at)}` : null, a.via === 'mcp' ? 'through Claude' : null].filter(Boolean).join(', ');

/** What came back. Shown in snapshots and archives too, where nothing can be typed. */
function answerBlock(item) {
  const earlier = (item.answers ?? []).filter((a) => a.id !== item.answer?.id).reverse();
  if (!item.answer && !earlier.length) return null;
  return h('div', { class: 'answer' },
    item.answer ? [
      h('p', { class: 'answer-head' }, h('strong', null, 'Answer'), answerLine(item.answer) ? ` — ${answerLine(item.answer)}` : ''),
      h('div', { class: 'prose', html: item.answer.bodyHtml }),
      item.state === 'changed' && item.answer.askedAs ? h('p', { class: 'slip-meta' }, `Given when the question read: “${item.answer.askedAs}”`) : null,
    ] : null,
    earlier.length ? h('details', { class: 'answer-history' },
      h('summary', null, item.answer ? plural(earlier.length, 'earlier answer') : plural(earlier.length, 'answer', 'answers') + ' from before it was reopened'),
      earlier.map((a) => h('div', { class: 'answer-earlier' }, h('p', { class: 'slip-meta' }, answerLine(a) || 'No source recorded'), h('div', { class: 'prose', html: a.bodyHtml }))),
    ) : null,
  );
}

/**
 * No <form>: the page's CSP sets form-action 'none'. Buttons and listeners only.
 * The height is set through the CSSOM, never a style attribute, for the same CSP.
 */
function composer(item) {
  const draft = state.drafts.get(item.id) ?? { body: '', source: '' };

  // A settled question does not need an open field under it. Offer one quietly,
  // unless there is a draft waiting, which must never be hidden.
  if (item.state === 'handled' && !state.reanswering.has(item.id) && !draft.body) {
    return h('div', { class: 'composer', dataset: { itemId: item.id } },
      h('div', { class: 'composer-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { state.reanswering.add(item.id); renderDetail(); requestAnimationFrame(() => focusComposer(item.id)); } },
          item.answer ? 'Record a newer answer' : 'Record an answer after all')));
  }

  const grow = (el) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };
  const bodyId = `answer-${item.fingerprint}`;

  const body = h('textarea', {
    id: bodyId, class: 'composer-body', rows: '3', maxlength: '8000', enterkeyhint: 'enter', autocapitalize: 'sentences',
    placeholder: item.to ? `What did ${item.to} say?` : 'What did they say?',
    oninput: (event) => { editDraft(item.id, 'body', event.target.value); grow(event.target); save.disabled = !event.target.value.trim(); },
    // Ctrl/Cmd+Enter saves. The page's global shortcuts stand down on Ctrl and Meta, so this is the only listener.
    onkeydown: (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && body.value.trim()) { event.preventDefault(); saveAnswer(item, body.value, source.value); } },
  });
  body.value = draft.body;
  const source = h('input', {
    type: 'text', class: 'composer-source', maxlength: '200', autocomplete: 'off',
    placeholder: 'Who said it, where, when',
    'aria-label': 'Who said it, where and when',
    oninput: (event) => editDraft(item.id, 'source', event.target.value),
  });
  source.value = draft.source;
  const save = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => saveAnswer(item, body.value, source.value) }, item.answer ? 'Replace the answer' : 'Save answer');
  save.disabled = !draft.body.trim();
  requestAnimationFrame(() => grow(body));

  const options = item.options?.length && !item.answer ? h('div', { class: 'composer-options', role: 'group', 'aria-label': 'Answer with one of the choices' },
    item.options.map((option) => h('button', { type: 'button', class: 'btn btn-option', onclick: () => saveAnswer(item, option, source.value) }, option))) : null;

  let drop = null;
  if (state.dropping === item.id) {
    const why = h('input', { type: 'text', class: 'composer-source', maxlength: '2000', placeholder: 'Why is no answer needed?', 'aria-label': 'Why is no answer needed?', oninput: () => { confirmDrop.disabled = !why.value.trim(); } });
    const confirmDrop = h('button', { type: 'button', class: 'btn', onclick: async () => { state.dropping = null; why.blur(); await tick(item, 'dropped', why.value); renderDetail(); } }, 'Drop the question');
    confirmDrop.disabled = true;
    drop = h('div', { class: 'composer-drop' },
      h('p', { class: 'slip-meta' }, 'Dropping lets implement start without an answer. The reason is kept with the question.'),
      why, h('div', { class: 'composer-actions' }, confirmDrop, h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { state.dropping = null; renderDetail(); } }, 'Cancel')));
    requestAnimationFrame(() => why.focus({ preventScroll: true }));
  }

  return h('div', {
    class: 'composer', dataset: { itemId: item.id },
    // Typing held a repaint back; paint it once focus has really left the composer.
    onfocusout: (event) => { if (!event.currentTarget.contains(event.relatedTarget) && state.detailStale) requestAnimationFrame(() => { if (!isTypingAnswer()) renderDetail(); }); },
  },
    drop,
    options,
    h('label', { class: 'composer-label', for: bodyId }, item.answer ? 'A newer answer' : options ? 'Or in your own words' : 'The answer'),
    body, source,
    h('div', { class: 'composer-actions' }, save, h('span', { class: 'slip-meta composer-hint' }, 'Markdown works. Ctrl+Enter saves.')),
  );
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const narrow = () => window.matchMedia('(max-width: 62rem)').matches;

function cell(label, value, { strong = false, mark = false } = {}) {
  return h('span', { class: 'cell', dataset: { label, strong, mark } }, mark ? h('span', null, value ?? '') : value ?? '');
}

function taskRow(task, { showStatus }) {
  const status = showStatus && task.status ? TASK_STATUS[task.status] : null;
  return h('div', {
    class: 'task-row',
    dataset: { dim: isFiltering() && !taskMatches(task) },
    onclick: (event) => { event.stopPropagation(); select({ type: 'task', id: task.id }, { focusDetail: narrow() }); },
  },
    h('span', { class: 'task-name', title: task.name },
      status ? h('span', { class: 'tick', title: status[1], 'aria-label': status[1] }, status[0]) : null,
      task.shortName),
    cell('Type', task.type),
    cell('Size', task.size, { strong: task.size === 'large' }),
    // Low confidence halts implement until the developer answers, so it is the one marked value.
    cell('Confidence', task.confidence, { mark: task.confidence === 'low' }),
    cell('Area', task.area),
    cell('Priority', task.priority, { strong: task.priority === 'urgent' }),
  );
}

function strip(b) {
  const m = state.model;
  const tasks = b.taskIds.map((id) => m.tasks[id]);
  const showStatus = ['in-flight', 'pr-open', 'shipped', 'stale'].includes(b.lane);
  const flags = [];
  if (b.blockingQuestions) flags.push(`${plural(b.blockingQuestions, 'question')} to answer first`);
  else if (b.openQuestions) flags.push(plural(b.openQuestions, 'open question'));

  return h('article', {
    class: 'strip',
    tabindex: '0',
    dataset: { lane: b.lane, reason: b.laneReason ?? '', nav: 'batch', id: b.key, trouble: isTrouble(b), changed: state.changed.has(b.key) },
    'aria-label': `${batchLabel(b)}: ${b.name}. ${batchNote(b)}.`,
    onclick: () => select({ type: 'batch', id: b.key }, { focusDetail: narrow() }),
  },
    h('div', { class: 'strip-tab', 'aria-hidden': 'true' }, b.number ?? '•', b.lane === 'shipped' ? h('small', null, 'done') : null),
    h('div', { class: 'strip-body' },
      h('div', { class: 'strip-head' },
        h('h3', { class: 'strip-name' }, b.name),
        h('p', { class: 'strip-note' }, batchNote(b), flags.map((f) => h('span', { class: 'flag' }, f))),
      ),
      b.lane === 'in-flight' && b.progress.total > 1
        ? h('div', { class: 'progress', 'aria-hidden': 'true' }, tasks.map((t) => h('span', { dataset: { s: t.status } })))
        : null,
      h('div', { class: 'task-rows' }, tasks.map((t) => taskRow(t, { showStatus }))),
    ),
  );
}

function unbatchedStrip(task) {
  return h('article', {
    class: 'strip strip-unbatched',
    tabindex: '0',
    dataset: { lane: 'unbatched', nav: 'task', id: task.id },
    onclick: () => select({ type: 'task', id: task.id }, { focusDetail: narrow() }),
  },
    h('div', { class: 'strip-tab', 'aria-hidden': 'true' }, DISPOSITION[task.disposition] || '—'),
    h('div', { class: 'strip-body' }, h('div', { class: 'task-rows' }, taskRow(task, { showStatus: false }))),
  );
}

function renderQueue() {
  const m = state.model;
  const body = $('queue-body');
  const scroll = $('queue').scrollTop;

  if (m.cycle.empty) {
    replace(body, h('div', { class: 'detail-empty' },
      h('h2', null, 'No triage data here yet'),
      h('p', null, 'Run the triage in your project and this page fills in on its own.'),
      h('div', { class: 'command' }, h('code', null, '/taskflow:triage'), copyButton('Copy', '/taskflow:triage', 'Command copied')),
    ));
    return;
  }

  const lanes = m.lanes.map((lane) => {
    let rows = [];
    let extra = null;

    if (lane.id === 'needs-you') {
      const items = m.laneOrder['needs-you'].map((id) => m.inbox[id]).filter(itemVisible);
      const open = items.filter((i) => i.state !== 'waiting');
      const waiting = items.filter((i) => i.state === 'waiting');
      const handled = m.laneOrder.handled.map((id) => m.inbox[id]).filter(itemVisible);
      rows = open.map((i) => slip(i));
      extra = [
        waiting.length ? [h('h3', { class: 'lane-sub' }, 'Waiting on someone else'), h('div', { class: 'lane-list' }, waiting.map((i) => slip(i)))] : null,
        handled.length ? h('p', { class: 'lane-sub' }, h('button', {
          type: 'button', class: 'btn btn-quiet', 'aria-expanded': String(state.showHandled),
          onclick: () => { state.showHandled = !state.showHandled; renderQueue(); },
        }, state.showHandled ? 'Hide handled' : `Show ${handled.length} handled`)) : null,
        state.showHandled && handled.length ? h('div', { class: 'lane-list' }, handled.map((i) => slip(i))) : null,
      ];
      if (!open.length && waiting.length) rows = [h('p', { class: 'lane-empty' }, 'Nothing needs you right now.')];
    } else if (lane.id === 'unbatched') {
      rows = m.laneOrder.unbatched.map((id) => m.tasks[id]).filter((t) => !isFiltering() || taskMatches(t)).map(unbatchedStrip);
      if (!rows.length) return null;
    } else {
      rows = m.laneOrder[lane.id].map((k) => m.batches[k]).filter(batchVisible).map(strip);
    }

    const total = lane.id === 'needs-you' ? lane.count : m.laneOrder[lane.id].length;
    const emptyText = isFiltering() && total > 0 ? 'Nothing here matches the filter.' : EMPTY_LANE[lane.id];
    // One header row per lane of strips: it labels every value under it, and
    // sticks to the top for as long as that lane is on screen.
    const columns = lane.id !== 'needs-you' && rows.length
      ? h('div', { class: 'columns', 'aria-hidden': 'true' }, ['Task', 'Type', 'Size', 'Confidence', 'Area', 'Priority'].map((label) => h('span', null, label)))
      : null;
    return h('section', { class: 'lane', id: `lane-${lane.id}`, 'aria-labelledby': `lane-title-${lane.id}` },
      h('div', { class: 'lane-head' },
        h('h2', { class: 'lane-title', id: `lane-title-${lane.id}` }, lane.label),
        h('span', { class: 'lane-count' }, total),
        LANE_HINT[lane.id] && rows.length ? h('span', { class: 'lane-hint' }, LANE_HINT[lane.id]) : null,
      ),
      columns,
      rows.length ? h('div', { class: 'lane-list' }, rows) : (!extra || !extra.some(Boolean)) ? h('p', { class: 'lane-empty' }, emptyText) : null,
      extra,
    );
  });

  replace(body, lanes);
  $('queue').scrollTop = scroll;
  markCurrent(false);
}

/** Which queue row stands for the current selection. */
function currentRowId() {
  const m = state.model;
  if (!state.sel || !m) return null;
  if (state.sel.type === 'task') return m.tasks[state.sel.id]?.batch ?? state.sel.id;
  return state.sel.id;
}

function markCurrent(scroll) {
  const id = currentRowId();
  for (const row of $('queue-body').querySelectorAll('[data-nav]')) {
    const on = row.dataset.id === id;
    if (on) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
    if (on && scroll) row.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// Chrome: top bar, lane navigation, filters
// ---------------------------------------------------------------------------

function renderTop() {
  const m = state.model;
  const c = m.cycle;
  const sentences = [];
  if (c.projectName) sentences.push(`${c.projectName}.`);
  if (c.lastTriage) sentences.push(`Triaged ${longDate(c.lastTriage)}${c.developer ? ` by ${c.developer}` : ''}${c.devHead ? ` at ${c.devHead}` : ''}.`);
  if (m.counts.tasks) {
    const agent = range({ ...m.totals.agent, caveats: 0, unparsed: 0 });
    sentences.push(`${plural(m.counts.tasks, 'task')} in ${plural(m.counts.batches, 'batch', 'batches')}${agent ? `, about ${agent} of agent time` : ''}.`);
  }
  if (c.isArchive) sentences.push('Archived, read-only.');
  $('cycle-line').textContent = sentences.join(' ');
  document.title = m.counts.needsYou ? `(${m.counts.needsYou}) Taskflow` : 'Taskflow';

  // An archive never changes, so "Live" would be a lie there.
  const live = $('live');
  const liveState = c.isArchive && !SNAPSHOT ? 'archive' : state.live;
  live.dataset.state = liveState;
  live.textContent = { live: 'Live', connecting: 'Connecting', retrying: 'Reconnecting', archive: 'Archive', snapshot: `Snapshot from ${new Date(m.generatedAt).toLocaleString('en-GB')}` }[liveState];

  const pick = $('cycle-select');
  pick.closest('label').hidden = Boolean(SNAPSHOT) || state.cycles.length < 2;
  replace(pick, state.cycles.map((cy) => h('option', { value: cy.id, selected: cy.id === state.cycle }, cy.isArchive ? `Archive ${cy.label ?? cy.id}` : 'Current cycle')));

  $('notes-button').hidden = !c.summaryFile;

  const banner = $('banner');
  banner.hidden = m.health.ok;
  if (!m.health.ok) {
    replace(banner, h('details', null,
      h('summary', null, `${plural(m.health.problems.length, 'thing')} in this cycle ${m.health.problems.length === 1 ? 'needs' : 'need'} a look`),
      h('ul', null, m.health.problems.map((p) => h('li', null, h('b', null, p.subject), ` ${p.message}`))),
    ));
  }
}

function renderLaneNav() {
  const m = state.model;
  replace($('lane-nav'), m.lanes
    .filter((lane) => lane.id !== 'unbatched' || lane.count > 0)
    .map((lane) => h('a', {
      class: 'lane-link', href: `#lane-${lane.id}`,
      dataset: { empty: lane.count === 0, attention: lane.attention },
      onclick: (event) => {
        event.preventDefault();
        document.body.dataset.pane = 'queue';
        document.getElementById(`lane-${lane.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      },
    }, h('b', null, lane.count), lane.label)));
}

function toggleFilter(key, value) {
  const values = (state.filters[key] ??= new Set());
  if (values.has(value)) values.delete(value);
  else values.add(value);
  writeHash();
  renderFilters();
  renderQueue();
}

function renderFilters() {
  const m = state.model;
  const tasks = Object.values(m.tasks);

  $('filter-button').setAttribute('aria-expanded', String(state.filtersOpen));
  const panel = $('filter-panel');
  panel.hidden = !state.filtersOpen;
  replace(panel, m.facets.filter((f) => f.values.length).map((facet) =>
    h('fieldset', { class: 'facet' },
      h('legend', null, facet.label),
      facet.values.map(({ value }) => {
        // Count under every *other* active filter, so the numbers say what a click would give.
        const count = tasks.filter((t) => t[facet.key] === value && taskMatches(t, facet.key)).length;
        return h('label', { dataset: { zero: count === 0 } },
          h('input', { type: 'checkbox', checked: state.filters[facet.key]?.has(value) || null, onchange: () => toggleFilter(facet.key, value) }),
          h('span', null, value), h('span', null, count));
      }),
    )));

  const labels = Object.fromEntries(m.facets.map((f) => [f.key, f.label]));
  replace($('active-filters'),
    activeFacets().flatMap(([key, values]) => [...values].map((value) =>
      h('span', { class: 'token' }, `${labels[key] ?? key}: ${value}`,
        h('button', { type: 'button', 'aria-label': `Remove the filter ${labels[key] ?? key} ${value}`, onclick: () => toggleFilter(key, value) }, '×')))),
    isFiltering() ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: clearFilters }, 'Clear filters') : null,
  );
}

function clearFilters() {
  state.filters = {};
  state.query = '';
  $('search').value = '';
  writeHash();
  renderFilters();
  renderQueue();
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

function refButton(key) {
  const b = state.model.batches[key];
  if (!b) return h('span', { class: 'ref' }, key);
  return h('button', { type: 'button', class: 'ref', title: `${b.name}. ${batchNote(b)}.`, onclick: () => select({ type: 'batch', id: key }) }, String(b.number ?? key));
}

function fact(label, ...value) {
  return [h('dt', null, label), h('dd', null, value)];
}

function laneSentence(b) {
  const label = { ready: 'Ready to start', 'in-flight': 'In flight', 'pr-open': 'Pull request open', blocked: 'Blocked', shipped: 'Shipped', stale: 'Stale' }[b.lane];
  return `${label}. ${batchNote(b)}.`;
}

function planBlock(task, container) {
  loadTaskDetail(task.id).then((detail) => {
    if (!detail || !container.isConnected) return;
    const sections = detail.sections.map((section, index) => {
      const key = `${task.id}:${section.slug}`;
      const open = state.sections.has(key) ? state.sections.get(key) : index === 0 || section.slug === 'open-question';
      const el = h('details', { open: open || null },
        h('summary', null, section.title),
        h('div', { class: 'prose', html: section.html }));
      el.addEventListener('toggle', () => state.sections.set(key, el.open));
      return el;
    });
    const shots = detail.attachments.filter((a) => a.type.startsWith('image/'));
    const files = detail.attachments.filter((a) => !a.type.startsWith('image/'));
    replace(container,
      sections.length ? sections : h('p', { class: 'slip-meta' }, 'No plan file for this task. Re-run the triage to write one.'),
      detail.truncated ? h('p', { class: 'slip-meta' }, 'This plan is very long. The end is cut off here; open the file for the rest.') : null,
      shots.length ? h('div', { class: 'shots' }, shots.map((a) => h('button', {
        type: 'button', class: 'shot', 'aria-label': `Open screenshot ${a.name}`,
        onclick: () => { $('lightbox-image').src = withCycle(a.url); $('lightbox-image').alt = a.name; $('lightbox').showModal(); },
      }, h('img', { src: withCycle(a.url), alt: '', loading: 'lazy' })))) : null,
      files.length ? h('p', { class: 'task-links' }, files.map((a) => h('a', { href: withCycle(a.url), target: '_blank', rel: 'noopener' }, a.name))) : null,
    );
  }).catch(() => replace(container, h('p', { class: 'slip-meta' }, 'Could not load the plan. The report server may have stopped.')));
}

function taskBlock(task) {
  const m = state.model;
  const status = task.status ? TASK_STATUS[task.status][1] : DISPOSITION[task.disposition];
  const facts = [['Type', task.type], ['Size', task.size], ['Confidence', task.confidence], ['Area', task.area], ['Priority', task.priority], ['Automation', task.implementable]]
    .filter(([, value]) => value);
  const agent = task.estimate.agent.raw;
  const human = task.estimate.human.raw;
  const plan = h('div', { class: 'plan' }, h('p', { class: 'slip-meta' }, 'Loading the plan'));
  planBlock(task, plan);

  return h('article', { class: 'task-block', id: `task-${task.id}`, dataset: { flash: state.sel?.type === 'task' && state.sel.id === task.id } },
    h('h3', { class: 'task-block-title' }, task.name),
    h('p', { class: 'task-facts' },
      status ? h('span', null, h('b', null, status)) : null,
      facts.map(([label, value]) => h('span', null, `${label} `, h('b', null, value)))),
    agent || human ? h('p', { class: 'task-facts' },
      agent ? h('span', null, 'Agent time ', h('b', null, agent)) : null,
      human ? h('span', null, 'By hand ', h('b', null, human)) : null) : null,
    h('p', { class: 'task-links' },
      task.url ? h('a', { href: task.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the ticket') : null,
      h('span', null, h('code', null, task.id)),
      task.commitShas.length ? h('span', null, 'Commit ', h('code', null, task.commitShas[task.commitShas.length - 1].slice(0, 9))) : null,
      task.carriedOverFrom ? h('span', null, `Carried over from ${task.carriedOverFrom}`) : null,
      task.providerStatus ? h('span', null, `Provider status: ${task.providerStatus}`) : null,
      task.duplicateOf ? h('span', null, 'Duplicate of ', h('code', null, task.duplicateOf)) : null,
    ),
    task.summary ? h('p', { class: 'prose' }, task.summary) : null,
    task.noteHtml ? h('div', { class: 'prose', html: task.noteHtml }) : null,
    task.inboxIds.filter((id) => !m.tasks[task.id].batch).map((id) => slip(m.inbox[id], { inDetail: true })),
    plan,
  );
}

function batchDetail(b) {
  const m = state.model;
  const tasks = b.taskIds.map((id) => m.tasks[id]);
  const items = Object.values(m.inbox).filter((i) => i.subject.batch === b.key).sort((a, c) => a.rank - c.rank);
  const command = b.unlockCommand && (b.laneReason === 'stale-lock' || b.lane === 'stale') ? b.unlockCommand : ['ready', 'blocked', 'in-flight'].includes(b.lane) ? b.command : null;
  const branch = b.branch ?? b.suggestedBranch;
  const agent = range(b.estimate.agent);
  const human = range(b.estimate.human);

  return [
    h('div', { class: 'detail-head' },
      h('div', { class: 'detail-num', dataset: { lane: b.lane }, 'aria-hidden': 'true' }, b.number ?? '•'),
      h('div', null,
        h('h2', { class: 'detail-title' }, b.name),
        h('p', { class: 'detail-state' }, laneSentence(b)))),
    command ? h('div', { class: 'command' }, h('code', null, command), copyButton('Copy command', command, 'Command copied', 'btn btn-primary')) : null,
    h('dl', { class: 'facts' },
      branch ? fact(b.branch ? 'Branch' : 'Suggested branch', h('code', null, branch), copyButton('Copy', branch, 'Branch copied', 'btn btn-quiet')) : null,
      b.dependsOn.length ? fact('Waits on', b.dependsOn.map((d) => refButton(d.key)), b.blockedBy.length ? `${b.blockedBy.length} still to finish` : 'all finished') : fact('Waits on', 'Nothing'),
      b.unblocks.length ? fact('Unblocks', b.unblocks.map(refButton)) : null,
      b.stackOn ? fact('Stacks on', refButton(b.stackOn.key), b.stackOn.branch ? h('code', null, b.stackOn.branch) : null) : null,
      b.pr ? fact('Pull request', h('a', { href: b.pr.url, target: '_blank', rel: 'noopener noreferrer' }, b.pr.number ? `#${b.pr.number}` : 'Open it'), b.pr.state !== 'unknown' ? ` ${b.pr.state}` : '') : null,
      b.worktree ? fact('Worktree', h('code', null, b.worktree.path)) : null,
      agent ? fact('Agent time', agent) : null,
      human ? fact('By hand', human) : null,
      b.lastActivityAt && b.lane !== 'ready' ? fact('Last activity', ago(b.lastActivityAt)) : null,
      b.flags.length ? fact('Notes', list(b.flags.map((f) => ({ 'no-batch-file': 'no batch file yet', 'batch-unreadable': 'batch file unreadable', 'unknown-status': `unknown status "${b.rawStatus}"`, 'self-dependency': 'listed itself as a dependency' }[f] ?? f)))) : null,
    ),
    items.length ? h('section', { class: 'section' }, h('h3', { class: 'section-title' }, 'Waiting on you'), h('div', { class: 'lane-list' }, items.map((i) => slip(i, { inDetail: true })))) : null,
    b.rationaleHtml ? h('section', { class: 'section' }, h('h3', { class: 'section-title' }, 'Why these go together'), h('div', { class: 'prose', html: b.rationaleHtml })) : null,
    h('section', { class: 'section' }, h('h3', { class: 'section-title' }, tasks.length === 1 ? 'The task' : `${tasks.length} tasks`), tasks.map(taskBlock)),
  ];
}

function renderDetail() {
  const m = state.model;
  const pane = $('detail');
  if (!m) return;

  let content;
  let scrollTo = null;
  const sel = state.sel;
  const back = h('button', { type: 'button', class: 'btn detail-back', onclick: () => { document.body.dataset.pane = 'queue'; $('queue').focus(); } }, 'Back to the queue');

  if (sel?.type === 'batch' && m.batches[sel.id]) {
    content = batchDetail(m.batches[sel.id]);
  } else if (sel?.type === 'task' && m.tasks[sel.id]) {
    const task = m.tasks[sel.id];
    if (task.batch) { content = batchDetail(m.batches[task.batch]); scrollTo = `task-${task.id}`; }
    else content = [h('div', { class: 'detail-head' }, h('div', { class: 'detail-num', dataset: { lane: 'stale' }, 'aria-hidden': 'true' }, '—'), h('div', null, h('h2', { class: 'detail-title' }, DISPOSITION[task.disposition] || 'Not batched'), h('p', { class: 'detail-state' }, 'This task is not part of any batch, so implement will not pick it up.'))), taskBlock(task)];
  } else if (sel?.type === 'item' && m.inbox[sel.id]) {
    const item = m.inbox[sel.id];
    const subjectBatch = item.subject.batch ? m.batches[item.subject.batch] : null;
    if (subjectBatch) content = batchDetail(subjectBatch);
    else if (item.subject.type === 'task' && m.tasks[item.subject.id]) content = [h('div', { class: 'detail-head' }, h('div', { class: 'detail-num', dataset: { lane: 'stale' }, 'aria-hidden': 'true' }, '—'), h('div', null, h('h2', { class: 'detail-title' }, item.title), h('p', { class: 'detail-state' }, itemMeta(item)))), taskBlock(m.tasks[item.subject.id])];
    else content = [h('div', { class: 'detail-head' }, h('div', { class: 'detail-num', 'aria-hidden': 'true' }, KIND[item.kind]?.glyph ?? '•'), h('div', null, h('h2', { class: 'detail-title' }, item.title), h('p', { class: 'detail-state' }, itemMeta(item)))), h('section', { class: 'section' }, slip(item, { inDetail: true }))];
  } else {
    const first = m.laneOrder['needs-you'][0] ? 'Start at the top: the first thing under "Needs you" is the one most likely to be holding work up.' : m.laneOrder.ready[0] ? 'Nothing is waiting on you. The first batch under "Ready to start" is what implement will claim next.' : 'Pick a row on the left to see its plan.';
    content = m.cycle.empty ? [] : [h('div', { class: 'detail-empty' }, h('h2', null, 'Pick a row to see its plan'), h('p', null, first), h('p', null, 'Press ? for the keyboard shortcuts.'))];
  }

  const key = `${sel?.type}:${sel?.id}`;
  // Replacing the pane under a typist ends an IME or autocorrect composition, and
  // iOS will not reopen the keyboard for a focus() we make. Wait for the blur.
  if (key === state.detailKey && isTypingAnswer()) { state.detailStale = true; return; }
  state.detailStale = false;
  const keepScroll = key === state.detailKey ? pane.scrollTop : 0;
  state.detailKey = key;
  replace(pane, back, content);
  pane.scrollTop = keepScroll;
  if (scrollTo && keepScroll === 0) requestAnimationFrame(() => document.getElementById(scrollTo)?.scrollIntoView({ block: 'start' }));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  renderTop();
  renderLaneNav();
  renderFilters();
  renderQueue();
  renderDetail();
  state.changed = new Set();
}

// ---------------------------------------------------------------------------
// Live updates: SSE tells us a new version exists; we fetch it conditionally.
// Polling takes over whenever the stream is down.
// ---------------------------------------------------------------------------

let source = null;
let pollTimer = null;

function setLive(next) {
  state.live = next;
  if (state.model) renderTop();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => loadModel({ announce: true }).then(() => setLive(source ? state.live : 'retrying')).catch(() => setLive('retrying')), 5000);
}

function connect() {
  if (SNAPSHOT || source || document.hidden) return;
  if (state.cycle !== 'live') { setLive('live'); return; }
  source = new EventSource('api/events');
  source.addEventListener('open', () => { clearInterval(pollTimer); pollTimer = null; setLive('live'); loadModel({ announce: true }).catch(() => {}); });
  source.addEventListener('model', () => loadModel({ announce: true }).catch(() => {}));
  source.addEventListener('error', () => { setLive('retrying'); startPolling(); });
}

function disconnect() {
  source?.close();
  source = null;
  clearInterval(pollTimer);
  pollTimer = null;
}

// Browsers allow six connections per origin. A hidden tab gives its stream back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) disconnect();
  else { connect(); loadModel({ announce: true }).catch(() => {}); }
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function moveSelection(step) {
  const rows = [...$('queue-body').querySelectorAll('[data-nav]')];
  if (!rows.length) return;
  const at = rows.findIndex((row) => row.getAttribute('aria-current') === 'true');
  const next = rows[Math.min(rows.length - 1, Math.max(0, at === -1 ? 0 : at + step))];
  select({ type: next.dataset.nav, id: next.dataset.id });
  next.focus({ preventScroll: true });
}

function selectedCommand() {
  const m = state.model;
  const sel = state.sel;
  if (!sel) return null;
  if (sel.type === 'item') return m.inbox[sel.id]?.command ?? m.inbox[sel.id]?.copyText ?? null;
  const key = sel.type === 'task' ? m.tasks[sel.id]?.batch : sel.id;
  const b = key ? m.batches[key] : null;
  if (!b) return null;
  return b.laneReason === 'stale-lock' ? b.unlockCommand : b.command;
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
  if (event.key === 'Escape') {
    if (document.querySelector('dialog[open]')) return;
    if (typing) { event.target.blur(); if (event.target.id === 'search' && state.query) clearFilters(); return; }
    document.body.dataset.pane = 'queue';
    return;
  }
  if (typing || document.querySelector('dialog[open]')) return;

  const actions = {
    j: () => moveSelection(1), ArrowDown: () => moveSelection(1),
    k: () => moveSelection(-1), ArrowUp: () => moveSelection(-1),
    '/': () => $('search').focus(),
    f: () => { state.filtersOpen = !state.filtersOpen; renderFilters(); },
    '?': () => $('help-dialog').showModal(),
    c: () => { const text = selectedCommand(); if (text) copy(text, 'Copied'); },
    x: () => {
      const item = state.sel?.type === 'item' ? state.model.inbox[state.sel.id] : null;
      if (item?.kind === 'question' && canTick() && item.state !== 'handled') { answerQuestion(item); return; }
      const step = item ? nextSteps(item)[0] : null;
      if (step) tick(item, step);
    },
    Enter: () => { if (state.sel && event.target.closest('[data-nav]')) { document.body.dataset.pane = 'detail'; $('detail').focus(); } },
  };
  const action = actions[event.key];
  if (!action) return;
  if (event.key !== 'Enter' || event.target.closest('[data-nav]')) event.preventDefault();
  action();
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const THEMES = ['system', 'light', 'dark'];
function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try { theme === 'system' ? localStorage.removeItem('taskflow-theme') : localStorage.setItem('taskflow-theme', theme); } catch { /* storage blocked */ }
  $('theme-button').textContent = `Theme: ${theme}`;
}

$('theme-button').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme ?? 'system';
  applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
});
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('filter-button').addEventListener('click', () => { state.filtersOpen = !state.filtersOpen; renderFilters(); });
$('search').addEventListener('input', (event) => { state.query = event.target.value; writeHash(); renderFilters(); renderQueue(); });

$('notes-button').addEventListener('click', async () => {
  const body = $('notes-body');
  replace(body, h('p', null, 'Loading the notes'));
  $('notes-dialog').showModal();
  try {
    const summary = SNAPSHOT ? SNAPSHOT.summary : await getJson('api/summary');
    replace(body, summary?.html ? h('div', { html: summary.html }) : h('p', null, 'This cycle has no summary file.'));
  } catch {
    replace(body, h('p', null, 'Could not load the notes. The report server may have stopped.'));
  }
});

$('cycle-select').addEventListener('change', async (event) => {
  state.cycle = event.target.value;
  state.sel = null;
  state.model = null;
  state.detailKey = null;
  writeHash({ push: true });
  disconnect();
  await loadModel();
  connect();
});

window.addEventListener('hashchange', () => {
  const before = state.cycle;
  readHash();
  if (state.cycle !== before) { state.model = null; loadModel().catch(() => {}); return; }
  $('search').value = state.query;
  if (state.model) render();
});

async function boot() {
  readHash();
  loadDrafts();
  $('search').value = state.query;
  applyTheme(document.documentElement.dataset.theme ?? 'system');
  document.body.dataset.pane = state.sel ? 'detail' : 'queue';
  try {
    if (!SNAPSHOT) state.cycles = (await fetch('api/cycles', { cache: 'no-store' }).then((r) => r.json())).cycles;
    if (!SNAPSHOT && !state.cycles.some((c) => c.id === state.cycle)) state.cycle = 'live';
    await loadModel();
    markCurrent(true);
    connect();
  } catch (error) {
    replace($('queue-body'), h('div', { class: 'detail-empty' }, h('h2', null, 'The report server is not answering'), h('p', null, 'Start it again with /taskflow:report, then reload this page.'), h('p', { class: 'slip-meta' }, String(error.message ?? error))));
  }
}

boot();
