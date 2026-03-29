---
name: report
description: Use when asked to view triage or implementation progress, open the task dashboard, or when user invokes /taskflow:report. Starts a local server showing live task status in the browser.
---

# Taskflow Report (`/taskflow:report`)

Start a live dashboard server that shows triage and implementation progress in the browser. The dashboard auto-refreshes every 10 seconds and reflects the current state of all batches.

## Invocation

```
/taskflow:report            # Start the report server
/taskflow:report --stop     # Stop the running report server
```

---

## Prerequisites

1. **Config file exists** at `.claude/taskflow-config.json` — if not, stop:
   > "No taskflow config found. Run `/taskflow:setup` first."

2. **Node.js is available** — check with `node --version`. If not found:
   > "Node.js is required for the report server. Install it and try again."

3. **Developer identity is in Claude memory** (to derive the developer slug for finding the index file)

---

## Start Flow

1. Read `.claude/taskflow-config.json` for `output_dir`.
2. Read developer identity from Claude memory. Derive `developer_slug`.
3. Resolve the absolute path to the output directory.
4. Check for an existing PID file at `<output_dir>/.report-server.pid`:
   - If the file exists, read the PID and check if the process is alive: `kill -0 <pid> 2>/dev/null`
   - If the process is alive: print the URL and stop:
     > "Report server already running at http://localhost:3847"
   - If the process is dead: remove the stale PID file and continue.

5. Locate the report server script. It is shipped with this plugin at:
   ```
   <plugin_base_dir>/scripts/report-server.mjs
   ```
   Where `<plugin_base_dir>` is the directory containing this SKILL.md's parent `skills/` directory (i.e., two levels up from this file's location).

   To find it programmatically: this skill file lives at `<plugin_base_dir>/skills/report/SKILL.md`. The script is at `<plugin_base_dir>/scripts/report-server.mjs`. Use the known plugin installation path from the Claude plugin cache.

6. Start the server in the background:
   ```bash
   nohup node <script_path> --dir <absolute_output_dir> --dev-slug <slug> > /dev/null 2>&1 &
   ```

7. Wait 1 second, then verify the PID file was created at `<output_dir>/.report-server.pid`.

8. Print:
   > "Report server started at http://localhost:3847"
   >
   > "Open in your browser to see live triage and implementation progress."

---

## Stop Flow (`--stop`)

1. Read `.claude/taskflow-config.json` for `output_dir`.
2. Check for PID file at `<output_dir>/.report-server.pid`:
   - If it does not exist: print "No report server is running." and stop.
3. Read the PID from the file.
4. Kill the process: `kill <pid> 2>/dev/null`
5. Remove the PID file.
6. Print: "Report server stopped."

---

## Standalone Usage

The report server can also be run directly without Claude:

```bash
node <plugin_path>/scripts/report-server.mjs --dir <output_dir> [--port 3847] [--dev-slug <slug>]
```

This is useful when you don't want to use a Claude session just to view the dashboard.
