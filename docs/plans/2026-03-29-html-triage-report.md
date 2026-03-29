# HTML Triage Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-contained HTML triage report as an additional output of `/taskflow:triage`.

**Architecture:** Add Step 8.5 to the triage SKILL.md between "Write Summary File" and "Print Terminal Summary." The step instructs Claude to generate a self-contained HTML file from the triage data. The HTML template (CSS, JS, structure) is embedded in the skill instructions. Update Step 9 to print the report path. Update the output file locations table.

**Tech Stack:** Markdown (SKILL.md), HTML/CSS/JS (inline template)

**Spec:** `docs/specs/2026-03-29-html-triage-report-design.md`
**Mockup reference:** `.superpowers/brainstorm/525260-1774782670/content/triage-report-mockup.html`

---

## File Structure

```
skills/triage/SKILL.md    # Modify: add Step 8.5, update Step 9, update output reference table
```

One file. No new files created.

---

### Task 1: Add Step 8.5 — Generate HTML Report

**Files:**
- Modify: `/home/rentorious/dev/taskflow/skills/triage/SKILL.md` (insert after Step 8, before Step 9)

- [ ] **Step 1: Read the current triage SKILL.md to find the insertion point**

Read `/home/rentorious/dev/taskflow/skills/triage/SKILL.md`. Find the end of Step 8 (Write Summary File) — it ends with the branch convention instructions. Find the start of Step 9 (Print Terminal Summary). The new step goes between them.

The insertion point is the `---` separator between Step 8 and Step 9. It looks like:

```markdown
---

### Step 9: Print Terminal Summary
```

- [ ] **Step 2: Insert Step 8.5 into the SKILL.md**

Insert the following markdown block between the end of Step 8 and the `---` before Step 9. Use the Edit tool to replace the `---` separator with the new step followed by a new separator.

Find this exact text:
```
---

### Step 9: Print Terminal Summary
```

Replace it with the full Step 8.5 content below, followed by the Step 9 header:

````markdown
---

### Step 8.5: Generate HTML Report

Generate a self-contained HTML triage report file. This report uses the same data already in memory from classification and batching — no additional data fetching needed.

Write the file to:

```
<config.output_dir>/triage-report.html
```

This file is overwritten on each triage run (not date-stamped).

#### Building the HTML

Generate a complete, self-contained HTML document. All CSS must be in a `<style>` block in the `<head>`. All JS must be in a `<script>` block before `</body>`. No external resources, CDNs, or imports.

Use the template structure and styling below. Populate it with the actual triage data.

#### HTML Template Structure

The document has these sections in order:

**1. Header:**
```html
<div class="header">
  <h1>Triage Report</h1>
  <div class="meta"><developer name> — <date formatted as "Month Day, Year"> — <N> tasks — <N> batches</div>
</div>
```

**2. Stats bar** — four stat cards in a flex row:
```html
<div class="stats">
  <div class="stat-card green"><div class="value"><total tasks></div><div class="label">Tasks Triaged</div></div>
  <div class="stat-card blue"><div class="value"><batch count></div><div class="label">Batches</div></div>
  <div class="stat-card yellow"><div class="value"><total agent time></div><div class="label">Agent Time</div></div>
  <div class="stat-card purple"><div class="value"><total human time></div><div class="label">Human Time</div></div>
</div>
```

**3. Area distribution bar** — a segmented horizontal bar showing task count per area, with a legend below:
```html
<div class="section-label">Area Distribution</div>
<div class="area-bar">
  <!-- One segment per area. flex value = task count for that area -->
  <div class="segment" style="flex: <count>; background: <color>;" title="<Area>: <count> tasks"></div>
</div>
<!-- Legend -->
<div class="area-legend">
  <span><span class="legend-dot" style="background:<color>;"></span><Area> (<count>)</span>
</div>
```

Assign colors from this palette in order of area appearance:
`#f85149`, `#58a6ff`, `#bc8cff`, `#d29922`, `#db6d28`, `#3fb950`, `#f778ba`, `#a5d6ff`

**4. Batch cards** — one per batch, first batch starts with class `open`:
```html
<div class="batch open"> <!-- first batch only; others omit "open" -->
  <div class="batch-header" onclick="this.parentElement.classList.toggle('open')">
    <div class="batch-title">
      <span class="chevron">&#9654;</span>
      <span class="batch-number"><N></span>
      <batch name>
    </div>
    <div class="batch-meta">
      <span><task count> tasks</span>
      <span>&middot;</span>
      <span>~<agent time> agent</span>
      <span>&middot;</span>
      <span>~<human time> human</span>
      <span>&middot;</span>
      <span class="branch-name"><suggested branch></span>
    </div>
  </div>
  <div class="batch-body">
    <!-- Task cards go here -->
    <div class="batch-totals">
      <span>Total: ~<human time> human &middot; ~<agent time> agent</span>
      <span>&middot;</span>
      <span>Branch: <code class="code-inline"><branch name></code></span>
    </div>
  </div>
</div>
```

**5. Task cards** — inside each batch body. First task in first batch starts with class `open`:
```html
<div class="task open"> <!-- first task in first batch only; others omit "open" -->
  <div class="task-header" onclick="this.parentElement.classList.toggle('open')">
    <div class="task-title">
      <span class="chevron">&#9654;</span>
      <task title>
    </div>
    <div class="task-badges">
      <span class="badge badge-<type>"><type></span>
      <span class="badge badge-<complexity>"><complexity></span>
      <span class="badge badge-<confidence>"><confidence></span>
      <span class="badge badge-area"><area></span>
    </div>
  </div>
  <div class="task-detail">
    <div class="detail-grid">
      <div class="detail-item">
        <div class="dl">Time Estimate</div>
        <div class="time-est"><span>&#9203; <human time> human</span><span>&#9889; <agent time> agent</span></div>
      </div>
      <div class="detail-item">
        <div class="dl">Task Link</div>
        <a class="task-link" href="<task url>" target="_blank"><task id> &rarr;</a>
      </div>
    </div>
    <!-- Files section: only if files array is non-empty -->
    <div class="detail-files">
      <div class="dl">Files Involved</div>
      <code><file path></code> <!-- one code element per file, separated by spaces or line breaks -->
    </div>
    <!-- Approach section: only if approach is non-empty -->
    <div class="detail-approach">
      <ol>
        <li><approach step 1></li>
        <li><approach step 2></li>
      </ol>
    </div>
  </div>
</div>
```

**6. Footer:**
```html
<div class="footer">
  Generated by <strong>taskflow</strong> — <code><config.output_dir>/triage-report.html</code>
</div>
```

#### Badge CSS Classes

Map classification values to badge classes:

| Field | Value | CSS Class |
|-------|-------|-----------|
| type | bug | `badge-bug` |
| type | feature | `badge-feature` |
| type | copy-change | `badge-feature` (same blue styling) |
| type | investigation | `badge-investigation` |
| complexity | small | `badge-small` |
| complexity | medium | `badge-medium` |
| complexity | large | `badge-medium` (same yellow styling) |
| confidence | high | `badge-high` |
| confidence | medium | `badge-medium` |
| confidence | low | `badge-low` |
| area | (any) | `badge-area` |

#### Complete CSS

Include this exact CSS in the `<style>` block:

```css
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --surface-hover: #1c2333;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --yellow: #d29922;
  --red: #f85149;
  --orange: #db6d28;
  --purple: #bc8cff;
  --radius: 8px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; line-height: 1.5; padding: 24px; max-width: 1100px; margin: 0 auto; }

.header { margin-bottom: 32px; }
.header h1 { font-size: 24px; font-weight: 600; margin-bottom: 4px; }
.header .meta { color: var(--text-muted); font-size: 14px; }

.stats { display: flex; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
.stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; flex: 1; min-width: 140px; }
.stat-card .value { font-size: 28px; font-weight: 700; }
.stat-card .label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
.stat-card.green .value { color: var(--green); }
.stat-card.yellow .value { color: var(--yellow); }
.stat-card.blue .value { color: var(--accent); }
.stat-card.purple .value { color: var(--purple); }

.section-label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }

.area-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin-bottom: 8px; gap: 2px; }
.area-bar .segment { border-radius: 4px; }
.area-legend { display: flex; gap: 16px; margin-bottom: 32px; font-size: 12px; color: var(--text-muted); flex-wrap: wrap; }
.legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }

.batch { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 16px; overflow: hidden; }
.batch-header { padding: 16px 20px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; user-select: none; }
.batch-header:hover { background: var(--surface-hover); }
.batch-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
.batch-meta { display: flex; gap: 16px; align-items: center; font-size: 13px; color: var(--text-muted); }
.batch-body { border-top: 1px solid var(--border); display: none; }
.batch.open .batch-body { display: block; }
.chevron { transition: transform 0.2s; font-size: 12px; color: var(--text-muted); }
.batch.open .chevron { transform: rotate(90deg); }
.batch-number { background: var(--border); color: var(--text); font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; }
.branch-name { font-family: monospace; font-size: 12px; }
.batch-totals { padding: 10px 20px; background: rgba(110,118,129,0.08); font-size: 13px; color: var(--text-muted); display: flex; gap: 24px; }
.code-inline { background: rgba(110,118,129,0.2); padding: 1px 6px; border-radius: 4px; font-size: 12px; }

.task { border-bottom: 1px solid var(--border); }
.task:last-child { border-bottom: none; }
.task-header { padding: 12px 20px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; }
.task-header:hover { background: var(--surface-hover); }
.task-title { font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.task-badges { display: flex; gap: 6px; align-items: center; }
.task-detail { display: none; padding: 0 20px 16px 20px; }
.task.open .task-detail { display: block; }

.badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.3px; }
.badge-bug { background: rgba(248, 81, 73, 0.15); color: var(--red); }
.badge-feature { background: rgba(88, 166, 255, 0.15); color: var(--accent); }
.badge-investigation { background: rgba(210, 153, 34, 0.15); color: var(--yellow); }
.badge-small { background: rgba(63, 185, 80, 0.15); color: var(--green); }
.badge-medium { background: rgba(210, 153, 34, 0.15); color: var(--yellow); }
.badge-high { background: rgba(63, 185, 80, 0.15); color: var(--green); }
.badge-low { background: rgba(248, 81, 73, 0.15); color: var(--red); }
.badge-area { background: rgba(188, 140, 255, 0.15); color: var(--purple); }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.detail-item { font-size: 13px; }
.detail-item .dl, .detail-files .dl { color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
.detail-approach { font-size: 13px; color: var(--text-muted); line-height: 1.6; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.detail-approach ol { padding-left: 20px; }
.detail-approach li { margin-bottom: 4px; }
.detail-files { font-size: 13px; margin-top: 8px; }
.detail-files code { background: rgba(110,118,129,0.2); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
.task-link { color: var(--accent); text-decoration: none; font-size: 12px; }
.task-link:hover { text-decoration: underline; }
.time-est { display: flex; gap: 16px; font-size: 13px; color: var(--text-muted); }
.time-est span { display: flex; align-items: center; gap: 4px; }
.footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-muted); }
```

#### Interaction JavaScript

Include this exact JS in a `<script>` block before `</body>`. No additional JS needed — the `onclick` handlers on batch and task headers handle expand/collapse via the CSS `.open` class toggling.

(No `<script>` block is needed — the `onclick="this.parentElement.classList.toggle('open')"` inline handlers on each header element are sufficient.)

---

### Step 9: Print Terminal Summary
````

- [ ] **Step 3: Update Step 9 to include the report file path**

Find the file locations block in Step 9:

```
State file:   <config.output_dir>/state.<developer_slug>.json
Summary file: <config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md
Plan files:   <config.output_dir>/tasks/<task-id>.md (one per task)
```

Replace with:

```
State file:   <config.output_dir>/state.<developer_slug>.json
Summary file: <config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md
Plan files:   <config.output_dir>/tasks/<task-id>.md (one per task)
Report file:  <config.output_dir>/triage-report.html
```

- [ ] **Step 4: Update the Output File Locations Reference table**

Find the output file locations reference table:

```markdown
| File          | Path                                                                |
| ------------- | ------------------------------------------------------------------- |
| State file    | `<config.output_dir>/state.<developer_slug>.json`                   |
| Summary file  | `<config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md`      |
| Per-task plan | `<config.output_dir>/tasks/<task-id>.md`                            |
```

Replace with:

```markdown
| File          | Path                                                                |
| ------------- | ------------------------------------------------------------------- |
| State file    | `<config.output_dir>/state.<developer_slug>.json`                   |
| Summary file  | `<config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md`      |
| Per-task plan | `<config.output_dir>/tasks/<task-id>.md`                            |
| HTML report   | `<config.output_dir>/triage-report.html`                            |
```

- [ ] **Step 5: Commit**

```bash
cd /home/rentorious/dev/taskflow && git add skills/triage/SKILL.md && git commit -m "feat: add HTML triage report generation (Step 8.5)"
```

- [ ] **Step 6: Push**

```bash
cd /home/rentorious/dev/taskflow && git push
```
