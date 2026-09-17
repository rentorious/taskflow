---
name: report
description: Use when asked to view triage or implementation progress, see what is ready, blocked or waiting on the developer, open the task dashboard, or when user invokes /taskflow:report. Starts a local server and prints the URL of the live report.
---

# Taskflow Report (`/taskflow:report`)

Start the report: a local page that groups the cycle by what happens next — what needs the developer, what is ready to claim, what is in flight, which pull requests are open, what is blocked and on what. It updates itself as `/taskflow:implement` sessions work; nobody needs to reload it.

The report only reads pipeline state. The one file it writes is `<output_dir>/report-inbox.<slug>.json`, where it remembers which inbox items the developer ticked off.

## Invocation

```
/taskflow:report                  # Start the server (or report the one already running)
/taskflow:report --stop           # Stop it
/taskflow:report --restart        # Stop, then start (use after updating the plugin)
/taskflow:report --port 4000      # Start on a specific port
/taskflow:report --snapshot       # Write a single-file HTML copy of the report, no server
```

---

## Prerequisites

1. **Config file exists** at `.claude/taskflow-config.json` — if not, stop:
   > "No taskflow config found. Run `/taskflow:setup` first."

2. **Node.js 18.17 or newer** — check with `node --version`. If missing or older:
   > "The report server needs Node.js 18.17 or newer."

No provider connection is needed. Developer identity is optional: the server finds `state.*.json` on its own, and `--dev-slug` only matters when several developers share one output directory.

---

## Locate the server script

The script ships with this plugin at `scripts/report-server.mjs`. Resolve it in this order and stop at the first path where `test -f <path>` succeeds:

1. `${CLAUDE_PLUGIN_ROOT}/scripts/report-server.mjs`
2. `<skill base directory>/../../scripts/report-server.mjs`, where the skill base directory is the one announced at the top of this skill when it was loaded (it ends in `skills/report`).

Never reuse a script path remembered from an earlier session or read from a running process. After a plugin update the old path still exists in the plugin cache and silently runs the previous version.

If neither path exists, stop and say so; do not search the filesystem for another copy.

---

## Start flow

1. Read `.claude/taskflow-config.json` for `output_dir`. Resolve it to an absolute path.

2. **Is a server already running for this directory?** Read `<output_dir>/.report-server.json` (fields: `pid`, `port`, `url`, `version`, `scriptPath`). If it is missing, fall back to `<output_dir>/.report-server.pid` (a bare pid, written by every version).
   - No file, or `kill -0 <pid>` fails: remove the stale files and go to step 3.
   - The process is alive: check that it is the current version.
     ```bash
     curl -s --max-time 2 <url>/api/health
     ```
     - JSON whose `version` equals this plugin's version and whose `scriptPath` equals the path you resolved: print the URL and stop.
       > "The report is already running at <url>"
     - Anything else (older version, a different `scriptPath`, HTML instead of JSON, no `.report-server.json` at all): it is an outdated server. Run the stop flow, then continue.

3. Start the server in the background:
   ```bash
   nohup node <script_path> --dir <absolute_output_dir> > /dev/null 2>&1 &
   ```
   Add `--port <n>` only if the developer asked for a port. Add `--dev-slug <slug>` only if the directory holds more than one `state.*.json`.

4. Wait one second, then read `<output_dir>/.report-server.json`. If it is not there, start the server once in the foreground to see the error, report it, and stop:
   ```bash
   node <script_path> --dir <absolute_output_dir>
   ```

5. Print the `url` from that file. The port is not always 3847: when the default port is taken the server moves up to the next free one.
   > "The report is running at <url>"

---

## Stop flow (`--stop`)

1. Read `output_dir` from the config.
2. Read the pid from `<output_dir>/.report-server.json`, or from `.report-server.pid` if that is all there is. Neither file: print "No report server is running." and stop.
3. `kill <pid>`. The server removes both files itself on the way out. Wait one second; if the process is still alive (`kill -0 <pid>`), `kill -9 <pid>`.
4. Remove whichever of the two files is left.
5. Print: "Report server stopped."

`--restart` is the stop flow followed by the start flow.

---

## Snapshot (`--snapshot`)

Writes the whole report as one HTML file that opens without a server. Use it to keep a record of a cycle or to show someone the state of play.

```bash
node <script_path> --dir <absolute_output_dir> --snapshot <absolute_output_dir>/report-snapshot.html
```

- Write it **inside the output directory**. Screenshots are linked, not embedded, and only resolve from there.
- The file contains ticket text. `output_dir` is normally gitignored; do not move the snapshot somewhere that is committed or shared without the developer asking for that.
- Add `--cycle <archive-name>` to snapshot an archived cycle.

---

## What the page shows

Use this to answer questions about the report without opening it.

- **Needs you** — questions to send to the client, provider writes that failed and must be pasted by hand, fixes to verify and close, suggested new tickets, and broken pipeline state (a stale lock, a batch in progress with no lock, a dependency that can never resolve, a pull request closed without merging). Items come from `needs[]` and `suggestions[]` in the index; for cycles triaged before those existed, from each plan file's `## Open Question`.
- **Ready to start** — exactly the batches `/taskflow:implement` would claim, in the order it would claim them.
- **In flight**, **Pull request open**, **Blocked** (with the batches it waits on), **Shipped and stale**, **Not batched**.
- Pull request state (merged, closed, failing checks) and leftover worktrees come from `gh` and `git` when they are available. Without them the report still works; merged pull requests simply stay under "Pull request open".
- Archived cycles under `<output_dir>/archive/` are selectable and read-only.

---

## Standalone usage

The server runs without Claude:

```bash
node <plugin_path>/scripts/report-server.mjs --dir <output_dir> [--port 3847] [--dev-slug <slug>] [--project <root>] [--no-enrich]
```

`--no-pidfile` starts a second, unregistered server beside a running one (for working on the report itself). `--print-model` prints the JSON the page is built from and exits.

The server listens on `127.0.0.1` only.
