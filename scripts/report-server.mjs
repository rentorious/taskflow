#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

// --- Argument parsing ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const dir = resolve(getArg('--dir', ''));
const port = parseInt(getArg('--port', '3847'), 10);
let devSlug = getArg('--dev-slug', '');

if (!dir) {
  console.error('Usage: node report-server.mjs --dir <output_dir> [--port 3847] [--dev-slug name]');
  process.exit(1);
}

if (!existsSync(dir)) {
  console.error(`Directory not found: ${dir}`);
  process.exit(1);
}

// Auto-detect dev slug from state.*.json
if (!devSlug) {
  const files = readdirSync(dir).filter(f => f.startsWith('state.') && f.endsWith('.json'));
  if (files.length > 0) {
    devSlug = files[0].replace('state.', '').replace('.json', '');
  }
}

const indexPath = join(dir, `state.${devSlug}.json`);
const batchesDir = join(dir, 'batches');
const pidPath = join(dir, '.report-server.pid');

// --- State reading ---
function readState() {
  if (!existsSync(indexPath)) return null;

  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const batches = {};

  if (existsSync(batchesDir)) {
    for (const key of Object.keys(index.batches || {})) {
      const batchFile = join(batchesDir, `${key}.json`);
      const lockDir = join(batchesDir, `${key}.lock`);
      const locked = existsSync(lockDir);

      if (existsSync(batchFile)) {
        batches[key] = { ...JSON.parse(readFileSync(batchFile, 'utf8')), locked };
      } else {
        batches[key] = { status: 'pending', branch: null, pr_url: null, tasks: {}, locked };
      }
    }
  }

  return { index, batches };
}

// --- HTML generation ---
const COLORS = ['#f85149','#58a6ff','#bc8cff','#d29922','#db6d28','#3fb950','#f778ba','#a5d6ff'];

const BADGE_MAP = {
  bug: 'badge-bug', feature: 'badge-feature', 'copy-change': 'badge-feature',
  investigation: 'badge-investigation',
  small: 'badge-small', medium: 'badge-medium', large: 'badge-medium',
  high: 'badge-high', low: 'badge-low',
};

const STATUS_BADGE = {
  pending: '<span class="status-badge status-pending">PENDING</span>',
  'in-progress': '<span class="status-badge status-progress">IN PROGRESS</span>',
  'pr-created': '<span class="status-badge status-done">PR CREATED</span>',
  stale: '<span class="status-badge status-stale">STALE</span>',
};

function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildHtml(state) {
  const { index, batches } = state;
  const taskCount = Object.keys(index.tasks).length;
  const batchKeys = Object.keys(index.batches);
  const batchCount = batchKeys.length;

  // Area distribution
  const areaCounts = {};
  for (const t of Object.values(index.tasks)) {
    const a = t.classification?.area || 'unknown';
    areaCounts[a] = (areaCounts[a] || 0) + 1;
  }
  const areaNames = Object.keys(areaCounts);

  // Time totals (simple concatenation — these are strings like "30 min")
  let totalAgentParts = [], totalHumanParts = [];
  for (const t of Object.values(index.tasks)) {
    if (t.classification?.time_estimate_agent) totalAgentParts.push(t.classification.time_estimate_agent);
    if (t.classification?.time_estimate_human) totalHumanParts.push(t.classification.time_estimate_human);
  }

  // Area bar segments
  const areaBar = areaNames.map((a, i) =>
    `<div class="segment" style="flex:${areaCounts[a]};background:${COLORS[i % COLORS.length]}" title="${escapeHtml(a)}: ${areaCounts[a]} tasks"></div>`
  ).join('');

  const areaLegend = areaNames.map((a, i) =>
    `<span><span class="legend-dot" style="background:${COLORS[i % COLORS.length]}"></span>${escapeHtml(a)} (${areaCounts[a]})</span>`
  ).join('');

  // Batch cards
  const batchCards = batchKeys.map((key, bi) => {
    const bInfo = index.batches[key];
    const bState = batches[key] || { status: 'pending', tasks: {}, locked: false };
    const taskIds = bInfo.tasks || [];
    const statusBadge = STATUS_BADGE[bState.status] || STATUS_BADGE.pending;
    const lockIcon = bState.locked ? ' &#128274;' : '';

    // Task progress counts
    let committed = 0, inProgress = 0, planned = 0;
    for (const tid of taskIds) {
      const ts = bState.tasks?.[tid]?.status || 'planned';
      if (ts === 'committed') committed++;
      else if (ts === 'in-progress') inProgress++;
      else planned++;
    }
    const total = taskIds.length || 1;
    const progressBar = `<div class="progress-bar"><div class="progress-committed" style="width:${committed/total*100}%"></div><div class="progress-active" style="width:${inProgress/total*100}%"></div></div>`;

    // Per-batch time totals
    const batchAgentParts = [], batchHumanParts = [];
    for (const tid of taskIds) {
      const t = index.tasks[tid];
      if (t?.classification?.time_estimate_agent) batchAgentParts.push(t.classification.time_estimate_agent);
      if (t?.classification?.time_estimate_human) batchHumanParts.push(t.classification.time_estimate_human);
    }

    const prLink = bState.pr_url ? ` &middot; <a class="task-link" href="${escapeHtml(bState.pr_url)}" target="_blank">PR &rarr;</a>` : '';
    const branchDisplay = bState.branch || bInfo.suggested_branch || '';

    // Task rows
    const taskRows = taskIds.map((tid, ti) => {
      const t = index.tasks[tid];
      if (!t) return '';
      const c = t.classification || {};
      const ts = bState.tasks?.[tid] || {};
      const taskStatus = ts.status || 'planned';
      const check = taskStatus === 'committed' ? '&#10003; ' : '';
      const sha = (ts.commit_shas && ts.commit_shas.length > 0) ? `<code class="code-inline">${ts.commit_shas[ts.commit_shas.length-1]?.substring(0,8) || ''}</code>` : '';
      const openClass = (bi === 0 && ti === 0) ? ' open' : '';

      return `<div class="task${openClass}">
  <div class="task-header" onclick="this.parentElement.classList.toggle('open')">
    <div class="task-title"><span class="chevron">&#9654;</span>${check}${escapeHtml(t.name)}</div>
    <div class="task-badges">
      <span class="badge ${BADGE_MAP[c.type] || 'badge-feature'}">${escapeHtml(c.type)}</span>
      <span class="badge ${BADGE_MAP[c.complexity] || 'badge-medium'}">${escapeHtml(c.complexity)}</span>
      <span class="badge ${BADGE_MAP[c.confidence] || 'badge-medium'}">${escapeHtml(c.confidence)}</span>
      <span class="badge badge-area">${escapeHtml(c.area)}</span>
      ${sha}
    </div>
  </div>
  <div class="task-detail">
    <div class="detail-grid">
      <div class="detail-item"><div class="dl">Time Estimate</div><div class="time-est"><span>&#9203; ${escapeHtml(c.time_estimate_human)} human</span><span>&#9889; ${escapeHtml(c.time_estimate_agent)} agent</span></div></div>
      <div class="detail-item"><div class="dl">Task Link</div><a class="task-link" href="${escapeHtml(t.url)}" target="_blank">${escapeHtml(tid)} &rarr;</a></div>
    </div>
  </div>
</div>`;
    }).join('\n');

    const openClass = bi === 0 ? ' open' : '';
    return `<div class="batch${openClass}">
  <div class="batch-header" onclick="this.parentElement.classList.toggle('open')">
    <div class="batch-title"><span class="chevron">&#9654;</span><span class="batch-number">${bi+1}</span>${escapeHtml(bInfo.name)} ${statusBadge}${lockIcon}</div>
    <div class="batch-meta"><span>${taskIds.length} tasks</span>${prLink}<span class="branch-name">${escapeHtml(branchDisplay)}</span></div>
  </div>
  <div class="batch-body">
    ${progressBar}
    ${taskRows}
    <div class="batch-totals"><span>${committed}/${taskIds.length} committed</span></div>
  </div>
</div>`;
  }).join('\n');

  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="10">
<title>Taskflow Report</title>
<style>
:root{--bg:#0d1117;--surface:#161b22;--surface-hover:#1c2333;--border:#30363d;--text:#e6edf3;--text-muted:#8b949e;--accent:#58a6ff;--green:#3fb950;--yellow:#d29922;--red:#f85149;--orange:#db6d28;--purple:#bc8cff;--radius:8px}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.5;padding:24px;max-width:1100px;margin:0 auto}
.header{margin-bottom:32px}.header h1{font-size:24px;font-weight:600;margin-bottom:4px}.header .meta{color:var(--text-muted);font-size:14px}
.stats{display:flex;gap:16px;margin-bottom:32px;flex-wrap:wrap}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;flex:1;min-width:140px}
.stat-card .value{font-size:28px;font-weight:700}.stat-card .label{font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.stat-card.green .value{color:var(--green)}.stat-card.yellow .value{color:var(--yellow)}.stat-card.blue .value{color:var(--accent)}.stat-card.purple .value{color:var(--purple)}
.section-label{font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
.area-bar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin-bottom:8px;gap:2px}.area-bar .segment{border-radius:4px}
.area-legend{display:flex;gap:16px;margin-bottom:32px;font-size:12px;color:var(--text-muted);flex-wrap:wrap}
.legend-dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
.batch{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:16px;overflow:hidden}
.batch-header{padding:16px 20px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none}
.batch-header:hover{background:var(--surface-hover)}
.batch-title{font-size:16px;font-weight:600;display:flex;align-items:center;gap:10px}
.batch-meta{display:flex;gap:16px;align-items:center;font-size:13px;color:var(--text-muted)}
.batch-body{border-top:1px solid var(--border);display:none}.batch.open .batch-body{display:block}
.chevron{transition:transform .2s;font-size:12px;color:var(--text-muted)}.batch.open .chevron{transform:rotate(90deg)}
.batch-number{background:var(--border);color:var(--text);font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px}
.branch-name{font-family:monospace;font-size:12px}
.batch-totals{padding:10px 20px;background:rgba(110,118,129,.08);font-size:13px;color:var(--text-muted);display:flex;gap:24px}
.code-inline{background:rgba(110,118,129,.2);padding:1px 6px;border-radius:4px;font-size:12px;font-family:monospace}
.task{border-bottom:1px solid var(--border)}.task:last-child{border-bottom:none}
.task-header{padding:12px 20px;cursor:pointer;display:flex;align-items:center;justify-content:space-between}
.task-header:hover{background:var(--surface-hover)}
.task-title{font-size:14px;font-weight:500;display:flex;align-items:center;gap:8px}
.task-badges{display:flex;gap:6px;align-items:center}
.task-detail{display:none;padding:0 20px 16px 20px}.task.open .task-detail{display:block}
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.3px}
.badge-bug{background:rgba(248,81,73,.15);color:var(--red)}.badge-feature{background:rgba(88,166,255,.15);color:var(--accent)}
.badge-investigation{background:rgba(210,153,34,.15);color:var(--yellow)}
.badge-small{background:rgba(63,185,80,.15);color:var(--green)}.badge-medium{background:rgba(210,153,34,.15);color:var(--yellow)}
.badge-high{background:rgba(63,185,80,.15);color:var(--green)}.badge-low{background:rgba(248,81,73,.15);color:var(--red)}
.badge-area{background:rgba(188,140,255,.15);color:var(--purple)}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.detail-item{font-size:13px}.detail-item .dl{color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.task-link{color:var(--accent);text-decoration:none;font-size:12px}.task-link:hover{text-decoration:underline}
.time-est{display:flex;gap:16px;font-size:13px;color:var(--text-muted)}.time-est span{display:flex;align-items:center;gap:4px}
.footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--text-muted)}
.status-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.5px;margin-left:8px}
.status-pending{background:rgba(139,148,158,.15);color:var(--text-muted)}
.status-progress{background:rgba(210,153,34,.15);color:var(--yellow)}
.status-done{background:rgba(63,185,80,.15);color:var(--green)}
.status-stale{background:rgba(248,81,73,.15);color:var(--red)}
.progress-bar{height:3px;display:flex;margin:0 20px 4px 20px;border-radius:2px;overflow:hidden;gap:1px;background:var(--border)}
.progress-committed{background:var(--green)}.progress-active{background:var(--yellow)}
</style>
</head>
<body>
<div class="header"><h1>Taskflow Report</h1><div class="meta">${escapeHtml(index.developer)} &mdash; ${date} &mdash; ${taskCount} tasks &mdash; ${batchCount} batches</div></div>
<div class="stats">
  <div class="stat-card green"><div class="value">${taskCount}</div><div class="label">Tasks Triaged</div></div>
  <div class="stat-card blue"><div class="value">${batchCount}</div><div class="label">Batches</div></div>
</div>
<div class="section-label">Area Distribution</div>
<div class="area-bar">${areaBar}</div>
<div class="area-legend">${areaLegend}</div>
<div class="section-label">Batches</div>
${batchCards}
<div class="footer">Auto-refreshing every 10 seconds &mdash; <code>taskflow report-server</code></div>
</body>
</html>`;
}

// --- Server ---
const server = createServer((req, res) => {
  if (req.url === '/api/status') {
    const state = readState();
    if (!state) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No triage data found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state, null, 2));
    return;
  }

  const state = readState();
  if (!state) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="10"><title>Taskflow</title>
<style>body{background:#0d1117;color:#8b949e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}</style>
</head><body><p>No triage data found. Run <code>/taskflow:triage</code> first.</p></body></html>`);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(buildHtml(state));
});

// PID file
writeFileSync(pidPath, String(process.pid));
process.on('SIGINT', () => { try { unlinkSync(pidPath); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { unlinkSync(pidPath); } catch {} process.exit(0); });

server.listen(port, () => {
  console.log(`Taskflow report: http://localhost:${port}`);
});
