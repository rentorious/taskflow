# Live Report Server Design

**Date:** 2026-03-29
**Status:** Approved
**Author:** Ognjen Popovic

## Overview

Add a live dashboard for viewing triage and implementation progress in the browser. A zero-dependency Node.js server reads the index + per-batch files and serves an auto-refreshing HTML report. Available as both a `/taskflow:report` skill and a standalone script.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js | Most likely available on web project dev machines; zero-dep with built-in `http`/`fs` |
| Invocation | Skill + standalone | Skill is a convenience wrapper; script works without Claude |
| Update mechanism | Regenerate on request + meta refresh (10s) | Simple, no WebSocket complexity, batch files are tiny |

## What Ships

```
taskflow/
├── scripts/
│   └── report-server.mjs     # Zero-dependency Node.js HTTP server
├── skills/
│   └── report/
│       └── SKILL.md           # /taskflow:report skill
└── ...
```

## Server Script (`scripts/report-server.mjs`)

### Usage

```bash
node report-server.mjs --dir <output_dir> [--port 3847] [--dev-slug ognjen]
```

### Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--dir` | Yes | — | Path to the output directory (e.g., `docs/plans/taskflow`) |
| `--port` | No | `3847` | Port to serve on |
| `--dev-slug` | No | auto-detect | Developer slug. If omitted, finds `state.*.json` in the dir |

### Behavior

**On startup:**
- Parse arguments
- Verify `--dir` exists and contains an index file (`state.*.json`)
- Write PID to `<dir>/.report-server.pid`
- Print: `Taskflow report: http://localhost:<port>`
- Start HTTP server

**On each request to `/`:**
1. Read the index file (`state.<slug>.json`)
2. For each batch in the index, read `batches/<batch-key>.json` for runtime status
3. Check for lock directories (`batches/<batch-key>.lock/`) via `fs.existsSync`
4. Build HTML report with the data (same visual design as the triage report)
5. Add batch status indicators:
   - **Pending** (no lock, status pending): gray badge
   - **Claimed/In Progress** (lock exists, status in-progress): yellow badge, shows per-task progress (committed vs in-progress vs planned)
   - **PR Created** (status pr-created): green badge with clickable PR link
   - **Locked** indicator on claimed batches
6. Include `<meta http-equiv="refresh" content="10">` for auto-polling
7. Return the HTML

**On request to `/api/status`:**
- Return raw JSON: merged index + all batch states
- Content-Type: `application/json`
- Useful for custom tooling

**Graceful behavior:**
- Index file missing: serve a page saying "No triage data found. Run `/taskflow:triage` first."
- Batch file missing: show the batch as "pending" (defensive fallback)
- Clean exit on SIGINT/SIGTERM (remove PID file)

### Implementation Notes

- Zero dependencies — only Node.js built-in modules (`http`, `fs`, `path`)
- ~100-150 lines total
- The HTML generation reuses the same CSS from the triage report (dark theme, cards, badges, expand/collapse)
- The HTML template is a string built in the script — no template engine

## Skill (`/taskflow:report`)

### Frontmatter

```yaml
---
name: report
description: Use when asked to view triage/implementation progress, start the report dashboard, or when user invokes /taskflow:report. Starts a local server showing live task status.
---
```

### Invocation

```
/taskflow:report          # Start the report server
/taskflow:report --stop   # Stop the running server
```

### Behavior

**Start:**
1. Read `.claude/taskflow-config.json` for `output_dir`
2. Read developer identity from memory for `developer_slug`
3. Check for existing PID file at `<output_dir>/.report-server.pid`
   - If PID file exists and process is alive: print "Report server already running at http://localhost:3847"
   - If PID file exists but process is dead: remove stale PID file, proceed to start
4. Locate the script at `<plugin_install_path>/scripts/report-server.mjs`
5. Run in background: `node <script_path> --dir <absolute_output_dir> --dev-slug <slug> &`
6. Print: "Report server started at http://localhost:3847"

**Stop (`--stop`):**
1. Read PID from `<output_dir>/.report-server.pid`
2. Kill the process
3. Remove the PID file
4. Print: "Report server stopped."

## Changes to Existing Skills

### Triage Step 9 (terminal summary)

After the file locations block, add:

```
Run /taskflow:report to view the live dashboard in your browser.
```

This is a one-line addition at the end of Step 9.

## Visual Design

The live report uses the same dark theme and component design as the static triage report, with these additions:

- **Auto-refresh indicator** — small text in the footer: "Auto-refreshing every 10 seconds"
- **Batch status badges** next to batch names:
  - Pending: gray pill `PENDING`
  - In Progress: yellow pill `IN PROGRESS` (with lock icon or indicator)
  - PR Created: green pill `PR CREATED` (clickable, links to PR)
- **Task progress bar** in each batch header — a thin bar showing proportion of committed/in-progress/planned tasks
- **Committed tasks** get a checkmark and show the short commit SHA
- **PR links** are clickable, open in new tab

## What Does NOT Change

- The static triage report (Step 8.5) still gets generated during triage
- The split state format is unchanged
- The implement skill is unchanged
- No new config fields needed
