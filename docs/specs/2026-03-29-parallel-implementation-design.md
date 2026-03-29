# Parallel-Safe Implementation Design

**Date:** 2026-03-29
**Status:** Approved
**Author:** Ognjen Popovic

## Overview

Refactor the state management in `/taskflow:triage` and `/taskflow:implement` to support parallel batch implementation. Multiple Claude Code sessions can run `/taskflow:implement` simultaneously, each working on a different batch in its own worktree, without race conditions or data loss.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Parallel mode | Always on (default) | Split state is strictly better even for single sessions — simpler I/O, no config knob |
| Consolidated view | Triage writes a read-only index | HTML report and terminal summary read one file for overview; implement never writes to it |
| Crash recovery | Manual unlock (`--unlock batch-N`) | Crashes are rare, user is present, simple and predictable |

## File Structure

```
<output_dir>/
  state.<dev>.json              # Index (written by triage only, read-only for implement)
  tasks/<task-id>.md            # Per-task plans (unchanged)
  batches/
    batch-1.json                # Batch working state (written by claiming implement session)
    batch-1.lock/               # Claim marker (directory, atomic via mkdir)
    batch-2.json
    batch-2.lock/
    ...
  triage-<dev>-<date>.md        # Summary (unchanged)
  triage-report.html            # HTML report (unchanged)
```

### Key Rules

- `state.<dev>.json` is the **index** — written only by triage. Implement and the HTML report read it but never write to it.
- `batches/batch-N.json` is the **per-batch working state** — written only by the implement session that claimed that batch.
- `batches/batch-N.lock/` is a **directory** (not a file) — created via `mkdir` which is atomic on all filesystems. Its existence means "someone claimed this batch."

## Index File Schema

`state.<dev>.json` — the read-only index written by triage:

```json
{
  "last_triage": "YYYY-MM-DD",
  "developer": "<Full Name>",
  "developer_id": "<provider_user_id>",
  "tasks": {
    "<task-id>": {
      "name": "<task title>",
      "url": "<task url>",
      "classification": {
        "area": "<area>",
        "type": "<type>",
        "complexity": "<complexity>",
        "confidence": "<confidence>",
        "implementable": "<yes|partial|no>",
        "time_estimate_human": "<e.g., '30 min'>",
        "time_estimate_agent": "<e.g., '10 min'>"
      },
      "batch": "<batch-1|batch-2|null>"
    }
  },
  "batches": {
    "batch-1": {
      "name": "<human-readable batch description>",
      "tasks": ["<task-id-1>", "<task-id-2>"],
      "suggested_branch": "<branch-name>"
    }
  }
}
```

Compared to the old monolithic state file:
- Tasks no longer have `status`, `branch`, `pr_url`, `commit_shas` — those live in per-batch files
- Batches no longer have `status` or `branch` — those live in per-batch files
- `suggested_branch` replaces `branch` (it's a suggestion from triage; implement confirms it)

## Per-Batch File Schema

`batches/batch-1.json` — created by triage with initial values, updated only by the implement session that claims it:

```json
{
  "status": "pending",
  "branch": null,
  "pr_url": null,
  "tasks": {
    "<task-id>": {
      "status": "planned",
      "commit_shas": []
    }
  }
}
```

### Status Lifecycle

**Batch status:** `"pending"` → `"in-progress"` → `"pr-created"`

**Task status within batch:** `"planned"` → `"in-progress"` → `"committed"`

Triage creates the file with `status: "pending"` and all tasks `"planned"`. Implement claims the batch, updates to `"in-progress"`, progresses each task, then sets `"pr-created"` with `pr_url` and `branch` after pushing.

Only one session ever writes to a given batch file — the one that successfully created the corresponding lock directory.

## Claim Flow

### With argument: `/taskflow:implement batch-2`

1. Check if `batches/batch-2.lock/` exists
2. If yes → stop: "Batch 2 is already claimed. Use `--unlock batch-2` to release it if the session crashed."
3. If no → run `mkdir batches/batch-2.lock/`
4. Read `batch-2.json` → proceed with implementation

### Without argument: `/taskflow:implement`

1. Read the index to get the batch list in key order (batch-1, batch-2, ...)
2. For each batch in order:
   - If `batches/batch-N.lock/` exists → skip (claimed by another session)
   - Read `batch-N.json` — if `status` is `"pr-created"` or `"done"` → skip (already complete)
   - Try `mkdir batches/batch-N.lock/`
   - If mkdir succeeds → claimed, proceed with this batch
   - If mkdir fails (race condition — another session grabbed it between the existence check and mkdir) → skip, try next batch
3. If no batch could be claimed → stop: "No available batches. All are either claimed, complete, or not yet triaged."

### Unlock: `/taskflow:implement --unlock batch-2`

1. Check `batches/batch-2.lock/` exists — if not, print "Batch 2 is not locked." and stop
2. Run `rmdir batches/batch-2.lock/`
3. Print: "Batch 2 unlocked. Run `/taskflow:implement` to claim it."
4. Does NOT reset the batch state — the batch file retains any progress. Committed tasks stay committed. Implement resumes from where it left off when reclaimed.

## Impact on Each Skill

### `/taskflow:triage`

**Step 7 (Write State File):**
- Writes the index file (`state.<dev>.json`) with task classifications and batch assignments
- Creates the `batches/` directory if it doesn't exist
- Writes initial `batch-N.json` files for each batch with `status: "pending"`

**Re-triage merge behavior:**
- Reads the index + reads all batch files to understand current state
- Only overwrites batch files for batches that are still `"pending"` (no lock directory, status is pending)
- Never touches batch files that are claimed (lock exists) or completed (`status: "pr-created"`)
- Stale tasks: if a task in a pending batch moved out of `todo` in the provider, update the index and the batch file. If a batch loses all tasks, remove it from the index and delete its batch file.

**Step 8.5 (HTML Report):**
- Reads the index for task classifications and batch assignments
- Reads each `batch-N.json` for runtime status (pending/in-progress/pr-created), branch, PR URL
- Merges both data sources to render the full report
- Shows batch status so parallel progress is visible

### `/taskflow:implement`

**Step 1 (Load State and Validate):**
- Reads the index for batch list and task classifications
- Runs the claim flow (Section 4 above)
- Reads the claimed `batch-N.json` for current progress
- Reads plan files from `<output_dir>/tasks/<task-id>.md` (unchanged)

**Steps 4-7 (Implement, Verify, Update Provider, Push/PR):**
- Reads/writes only `batches/batch-N.json` for the claimed batch
- All status updates, commit SHA recording, PR URL recording go to the batch file
- No other file is written

**Step 8 (Cleanup):**
- Does NOT remove the lock directory — lock stays to prevent re-claim
- Batch file has `status: "pr-created"` which is the completion signal
- Future `/taskflow:implement` sessions skip this batch based on status

**New argument: `--unlock batch-N`:**
- Invokes the unlock flow from Section 4
- Only removes the lock directory, does not modify batch state

### `/taskflow:setup`

No changes.

## Backwards Compatibility

The old monolithic state file format is replaced entirely. There is no migration path — users run `/taskflow:triage` to regenerate the new split format. Since the triage output (plan files, classifications) is the same, no work is lost. Only runtime state (which was transient anyway) is reset.

## What Does NOT Change

- The triage workflow (fetch, classify, enrich, plan, batch) is unchanged
- The implementation workflow (worktree, implement, verify, PR) is unchanged
- Task plan files (`tasks/<task-id>.md`) are unchanged
- The config file schema is unchanged — no new config fields
- The HTML report visual design is unchanged (it just reads from two sources instead of one)
- Provider operations (ClickUp MCP calls) are unchanged
