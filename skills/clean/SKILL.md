---
name: clean
description: Use when asked to wipe, clean, reset, or archive the local taskflow state, start a fresh triage cycle, or when user invokes /taskflow:clean. Stops the report server and moves the current cycle's index, batches, plans, attachments and summaries into an archive folder (or deletes everything with --purge). Local files only — never touches the provider.
---

# Taskflow Clean (`/taskflow:clean`)

Reset the local taskflow state for this project so the next `/taskflow:triage` starts from a blank index. By default the current cycle is **archived**, not deleted: every cycle file under `<config.output_dir>` moves into `<config.output_dir>/archive/<cycle-date>/`. `--purge` deletes the current cycle and every archive.

Scope is **local files only**. This skill never calls the provider — task statuses, descriptions, links and comments in ClickUp/Jira are left exactly as they are. It never touches `.claude/taskflow-config.json`, Claude memory (developer identity), git worktrees, or branches.

## Invocation

```
/taskflow:clean              # Archive the current cycle to <output_dir>/archive/<cycle-date>/
/taskflow:clean --purge      # Delete the current cycle AND all archives (asks for confirmation)
/taskflow:clean --dry-run    # Print what would be archived/deleted; change nothing (combine with --purge to preview a purge)
```

---

## Prerequisites

1. **Config file exists** at `.claude/taskflow-config.json` — if not, stop immediately:
   > "No taskflow config found. Run `/taskflow:setup` first."

No provider MCP connection and no developer identity are required — the skill discovers state files by globbing, so it works even when the provider is down.

---

## Step-by-Step Process

Follow these steps in order. Do not skip or reorder steps.

---

### Step 1: Load Config and Locate State

1. Read `.claude/taskflow-config.json` — take `output_dir`, `project_name`, and `provider`. Resolve `output_dir` to an absolute path under the project root.

2. If `<output_dir>` does not exist, or contains nothing except `archive/` and/or a `.report-server.pid`:
   - Remove a stale `.report-server.pid` if one is there (see Step 5).
   - If `--purge` was passed and `archive/` exists, continue — a purge still has archives to delete.
   - Otherwise print: "Nothing to clean — no active taskflow cycle in `<output_dir>`." and stop.

---

### Step 2: Inventory the Current Cycle

Build the list of cycle items at the top level of `<output_dir>`. **Everything except `archive/` and `.report-server.pid` is part of the cycle**, including dotfiles and files this skill does not recognize:

| Item                                                    | Written by         |
| ------------------------------------------------------- | ------------------ |
| `state.<developer_slug>.json` (glob `state.*.json`)     | triage             |
| `batches/` (batch files + `<batch-key>.lock/` dirs)     | triage / implement |
| `tasks/` (per-task plan files)                          | triage             |
| `attachments/` (downloaded task attachments)            | triage             |
| `triage-<developer_slug>-<YYYY-MM-DD>.md` (summaries)   | triage             |
| `triage-report.html`                                    | triage             |
| anything else at the top level                          | unknown — include it and name it in the report |

Then read:

- each `state.*.json` → `last_triage`, number of `tasks`, number of `batches`
- each `batches/*.json` → `status`, `branch`, `pr_url`
- every `batches/*.lock/` directory that exists

Determine the **cycle date**: `last_triage` from the index. If several indexes disagree, take the latest. If no index exists, use today's date as `YYYY-MM-DD`.

---

### Step 3: Safety Checks

Run every check and collect the findings before changing anything.

1. **Claimed batches.** For each `batches/<batch-key>.lock/`: if `<batch-key>.json` has `status: "in-progress"`, another session may be implementing it right now. If any such batch exists and `--dry-run` was NOT passed, ask ONE question and wait:

   > "<batch-key> is claimed and in progress (branch `<branch>`). Archiving now will not stop that session, and its later writes will land in an empty directory. Continue? [y/N]"

   Default is **No** — stop on anything but an explicit yes. Locks on batches whose status is `"pending"` are stale; no question needed.

2. **Worktrees.** For every batch with a non-null `branch`, check whether `../<config.project_name>-<branch>` is a live worktree (`git worktree list --porcelain`). Collect the matches. Clean **never** removes worktrees or branches — they may hold unpushed commits. They are listed in Step 7 with the exact removal command.

3. **Open PRs.** Batches with `status: "pr-created"` are informational only: the PR lives on the remote and the archived batch file keeps its `pr_url`.

4. **Report server.** Read `<output_dir>/.report-server.pid` if present and check `kill -0 <pid> 2>/dev/null`. Record one of: alive / stale / absent.

---

### Step 4: Dry Run

If `--dry-run` was passed: print the plan — mode (archive or purge), the target archive path, every item from Step 2 with file counts, every finding from Step 3, and whether the report server would be stopped — then **stop**. Write nothing, move nothing, kill nothing.

---

### Step 5: Stop the Report Server

Mirror the `/taskflow:report --stop` flow:

- If the PID is alive: `kill <pid>`, then poll `kill -0 <pid>` for up to 2 seconds until it fails.
- Remove `<output_dir>/.report-server.pid` whether the process was alive or stale.
- If there is no PID file: nothing to do.

Reason: the server reads `<output_dir>/state.*.json` and `batches/`. Once those move it only shows "no state", and on `--purge` it would keep an open handle on a deleted directory.

---

### Step 6a: Archive (default)

1. Target = `<output_dir>/archive/<cycle-date>/`. If that directory already exists, use `<cycle-date>-2`, then `-3`, and so on. **Never merge into or overwrite an existing archive.**

2. `mkdir -p <target>`.

3. `mv` every inventoried item from Step 2 into `<target>/`, preserving names. Batch `.lock/` directories move with `batches/` as-is — they record which batches were claimed at archive time.

4. Verify: `<output_dir>` now contains only `archive/`. If any cycle item remains, report it and stop — do **not** retry with `rm`.

---

### Step 6b: Purge (`--purge`)

1. Print the full inventory: the current-cycle item counts **and** every `archive/<name>/` with its file count and size.

2. Ask ONE question and wait:

   > "This permanently deletes the current cycle and <N> archive(s) under `<output_dir>` (<M> files, <S> total). The directory is gitignored — there is no copy in git. Type `yes` to continue."

   Anything other than exactly `yes` → stop with "Purge cancelled. Nothing was changed."

3. Delete every top-level entry inside `<output_dir>`, including `archive/`. Keep `<output_dir>` itself as an empty directory so the `.gitignore` entry and the `output_dir` setting still point at something real.

4. Verify `<output_dir>` is empty.

Never delete anything outside `<output_dir>`. Never delete `.claude/taskflow-config.json`.

---

### Step 7: Report

Print a terminal summary:

```
Taskflow state cleaned: <archived | purged>

Archive:        <output_dir>/archive/<cycle-date>/          (omit for purge)
Cycle:          triaged <last_triage> — <T> tasks, <B> batches
                  <n> pending · <n> in-progress · <n> pr-created · <n> other
Moved/Deleted:  <n> plan files, <n> attachments, <n> summaries, triage-report.html
Report server:  stopped (pid <pid>) | stale pid file removed | not running

Worktrees left in place (remove when done):
  git worktree remove ../<project_name>-<branch>     # <batch-key>, <status>

Provider untouched: task statuses in <provider> are unchanged. If a claimed batch had
moved tasks to "in progress", move them back by hand.

Next: /taskflow:triage      # starts a fresh cycle; every to-do task is treated as new
```

Omit the Worktrees block when there are none. Name any unrecognized top-level files that were moved or deleted.

---

## Error Handling

- **`mv` fails midway** (permissions, cross-device): stop immediately, list what has and has not moved, and print the `mv` commands needed to either finish or roll back. Do not fall back to copy-then-delete.
- **Report server will not exit** (`kill -0` still succeeds after 2 s): `kill -9 <pid>`, re-check, then continue. If it still survives, report the PID and continue — a live server pointed at an empty directory is harmless.
- **Unknown files at the top level** of `<output_dir>`: never skip them silently. Archive or purge them with the rest and name them in the report.
- **Config has no `output_dir`**: stop — "Config has no `output_dir`. Run `/taskflow:setup --reconfigure`."

---

## What Clean Does NOT Do

- Does not call the provider — no status changes, no comments, no link removal.
- Does not delete or reset `.claude/taskflow-config.json`.
- Does not touch Claude memory (developer identity survives).
- Does not remove git worktrees or branches, and does not close PRs.
- Does not touch `archive/` unless `--purge` was passed.

---

## Restoring an Archive

There is no `--restore`; the archive layout is the live layout, and archives contain no dotfiles. To bring a cycle back:

```bash
mv <output_dir>/archive/<cycle-date>/* <output_dir>/
rmdir <output_dir>/archive/<cycle-date>
```

`/taskflow:triage` then applies its normal re-triage merge behavior to that index.

---

## Output File Locations Reference

| File              | Path                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Config file       | `.claude/taskflow-config.json` (never modified)                                          |
| Archive root      | `<config.output_dir>/archive/`                                                           |
| Cycle archive     | `<config.output_dir>/archive/<cycle-date>/` — same layout as the live `<config.output_dir>` |
| Report server PID | `<config.output_dir>/.report-server.pid` (removed)                                       |

All paths are relative to the project root. Use absolute paths when moving or deleting files.
