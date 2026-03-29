# Parallel-Safe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor state management so multiple Claude sessions can run `/taskflow:implement` in parallel on different batches without race conditions.

**Architecture:** Split the monolithic state file into a read-only index (written by triage) and per-batch working files (each written by only one implement session). Use atomic `mkdir` for batch claiming. Add `--unlock` argument for crash recovery.

**Tech Stack:** Markdown (SKILL.md files)

**Spec:** `docs/specs/2026-03-29-parallel-implementation-design.md`

---

## File Structure

```
skills/triage/SKILL.md       # Modify: Step 7 (state schema), Step 8.5 (HTML report reads split files), re-triage merge behavior
skills/implement/SKILL.md    # Modify: invocation, Step 1 (claim flow), all state read/write references, error recovery, state fields table
```

Two files modified. No new files.

---

### Task 1: Update Triage Skill — Step 7 (State File Schema)

**Files:**
- Modify: `/home/rentorious/dev/taskflow/skills/triage/SKILL.md`

The state file schema in Step 7 needs to change from a monolithic format to the split format: an index file + per-batch files.

- [ ] **Step 1: Read current Step 7 to find exact content**

Read `/home/rentorious/dev/taskflow/skills/triage/SKILL.md` lines 361-417. The current Step 7 contains:
- The state file path
- Re-triage merge instructions
- The monolithic JSON schema
- Field notes

- [ ] **Step 2: Replace Step 7 content**

Replace everything from `### Step 7: Write State File` through the field notes (ending before `---` and `### Step 8: Write Summary File`) with the new split-state version.

The new Step 7 content:

````markdown
### Step 7: Write State and Batch Files

Write the triage output as a read-only index file plus per-batch working files.

#### 7a. Write the index file

Write to `<config.output_dir>/state.<developer_slug>.json`.

This file is the **read-only index** — it contains task classifications and batch assignments. `/taskflow:implement` reads this file but never writes to it.

**Index file schema:**

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
        "time_estimate_human": "<e.g., '30 min', '2 hours'>",
        "time_estimate_agent": "<e.g., '10 min', '30 min'>"
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

Field notes:
- Tasks have classification data only — no `status`, `branch`, `pr_url`, or `commit_shas` (those live in per-batch files)
- Batches have `suggested_branch` (a suggestion from triage), not `branch` (which implement confirms)
- `batch`: `null` for manual/non-implementable tasks

#### 7b. Write per-batch files

Create the `<config.output_dir>/batches/` directory if it does not exist.

For each batch, write an initial batch file to `<config.output_dir>/batches/<batch-key>.json`.

**Per-batch file schema:**

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

Field notes:
- `status`: always `"pending"` for new batches
- `branch`, `pr_url`: always `null` for new batches — `/taskflow:implement` fills these in
- Per-task `status`: always `"planned"` for new tasks
- Per-task `commit_shas`: always empty for new tasks

**Important:** Only write batch files for batches that do not already have a lock directory (`<config.output_dir>/batches/<batch-key>.lock/`). If a lock exists, that batch is claimed by an in-progress implement session — do not overwrite its batch file.

#### Re-triage merge behavior

**If an index file already existed (re-triage run):** Merge the new data into the index:

- Preserve existing task entries that were not re-triaged
- Update entries for tasks that were re-triaged
- Update stale task statuses
- Merge new tasks into the `tasks` map
- Rebuild the `batches` map to reflect all current batches

**For per-batch files during re-triage:**

| Batch state | Action |
|-------------|--------|
| Lock directory exists (`batches/<key>.lock/`) | Do not touch — batch is claimed by an active session |
| Batch file has `status: "pr-created"` | Do not touch — batch is complete |
| Batch file has `status: "pending"` (no lock) | Overwrite with fresh data |
| Batch file does not exist (new batch) | Create with initial schema |
| Batch lost all tasks due to staleness | Remove from index, delete batch file |
````

- [ ] **Step 3: Commit**

```bash
cd /home/rentorious/dev/taskflow && git add skills/triage/SKILL.md && git commit -m "refactor: split triage state into index + per-batch files (Step 7)"
```

---

### Task 2: Update Triage Skill — Step 8.5 (HTML Report) and Output References

**Files:**
- Modify: `/home/rentorious/dev/taskflow/skills/triage/SKILL.md`

The HTML report currently reads from the monolithic state. It now needs to read the index + per-batch files. Also update the re-triage merge behavior section, the terminal summary file paths, and the output file locations table.

- [ ] **Step 1: Update Step 8.5 data source instructions**

Find Step 8.5 in the triage SKILL.md. At the top of the step, after the output path, there is a line like:

> "This uses the same data already in memory from classification and batching"

This is still true — the HTML report is generated during triage, which has all the data in memory. No change needed to the data source text.

However, add a note after the output path section:

```markdown
**Data sources:** The report is generated from the triage data already in memory. If batch files exist from previous implement runs (e.g., some batches are `"in-progress"` or `"pr-created"`), read each `<config.output_dir>/batches/<batch-key>.json` to get current batch status. Merge this with the in-memory triage data to show accurate status for all batches.
```

- [ ] **Step 2: Update Step 9 file paths**

Find the file locations block in Step 9. It currently reads:

```
State file:   <config.output_dir>/state.<developer_slug>.json
Summary file: <config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md
Plan files:   <config.output_dir>/tasks/<task-id>.md (one per task)
Report file:  <config.output_dir>/triage-report.html
```

Replace with:

```
Index file:   <config.output_dir>/state.<developer_slug>.json
Batch files:  <config.output_dir>/batches/batch-N.json (one per batch)
Summary file: <config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md
Plan files:   <config.output_dir>/tasks/<task-id>.md (one per task)
Report file:  <config.output_dir>/triage-report.html
```

- [ ] **Step 3: Update Output File Locations Reference table**

Find the output file locations reference table. Replace with:

```markdown
| File           | Path                                                                |
| -------------- | ------------------------------------------------------------------- |
| Index file     | `<config.output_dir>/state.<developer_slug>.json`                   |
| Batch files    | `<config.output_dir>/batches/<batch-key>.json`                      |
| Batch locks    | `<config.output_dir>/batches/<batch-key>.lock/` (directory)         |
| Summary file   | `<config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md`      |
| Per-task plan  | `<config.output_dir>/tasks/<task-id>.md`                            |
| HTML report    | `<config.output_dir>/triage-report.html`                            |
```

- [ ] **Step 4: Update re-triage merge behavior section**

Find the "Re-triage Merge Behavior" section (the standalone section below Step 9). This section currently references the monolithic state file. Update it to reference the split format:

Replace the table:

```markdown
When `/taskflow:triage` is run again on an existing index file (without `--force`):

| Scenario                                                                                 | Action                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Task is new (not in index)                                                               | Add and triage normally                                               |
| Task is in index with a batch that is claimed (lock exists) or complete (pr-created)     | Skip — do not re-triage in-flight or completed work                   |
| Task is in index with a pending batch (no lock, status pending)                          | Skip unless `--force`                                                 |
| Task is in index but no longer `todo` in the provider                                    | Mark as stale in index; remove from batch file if batch is pending    |
| Batch loses all tasks due to staleness                                                   | Remove from index; delete batch file (only if not locked)             |

When `/taskflow:triage --force` is run:

- Re-triage all `todo` tasks, including already-planned ones in pending batches
- Overwrite plan files and pending batch files with fresh data
- Rebuild batches from scratch for unclaimed work
- Never touch claimed batches (lock exists) or completed batches (status: "pr-created") — even with `--force`
```

- [ ] **Step 5: Commit**

```bash
cd /home/rentorious/dev/taskflow && git add skills/triage/SKILL.md && git commit -m "refactor: update triage output refs for split state format"
```

---

### Task 3: Update Implement Skill — Invocation, Step 1, and Claim Flow

**Files:**
- Modify: `/home/rentorious/dev/taskflow/skills/implement/SKILL.md`

This is the biggest change. The implement skill needs: updated invocation (add `--unlock`), new claim flow in Step 1, all state file references updated to per-batch files.

- [ ] **Step 1: Update the invocation section**

Find the invocation block:

```
/taskflow:implement              # Implement next pending batch
/taskflow:implement batch-2      # Implement a specific batch by name
```

Replace with:

```
/taskflow:implement              # Implement next available batch
/taskflow:implement batch-2      # Implement a specific batch by name
/taskflow:implement --unlock batch-2   # Release a crashed session's claim on a batch
```

- [ ] **Step 2: Update Prerequisites**

Find prerequisite #4:

```markdown
4. **State file exists** at `<config.output_dir>/state.<developer_slug>.json` — if not, stop:
   > "No triage state found. Run `/taskflow:triage` first."
```

Replace with:

```markdown
4. **Index file exists** at `<config.output_dir>/state.<developer_slug>.json` — if not, stop:
   > "No triage state found. Run `/taskflow:triage` first."
```

- [ ] **Step 3: Rewrite Step 1 (Load State and Validate)**

Replace the entire Step 1 content with the new claim-based flow. Find `### Step 1: Load State and Validate` and replace everything through the `---` before Step 2.

New Step 1:

````markdown
### Step 1: Load State and Validate

1. Read `.claude/taskflow-config.json` — parse fully. Store the entire config object.

2. Read developer identity from Claude memory:
   - Full name, provider user ID, derive `developer_slug`

3. **Handle `--unlock` argument:**

   If the invocation is `/taskflow:implement --unlock <batch-key>`:
   - Check if `<config.output_dir>/batches/<batch-key>.lock/` exists
   - If it does not exist: print "Batch `<batch-key>` is not locked." and stop.
   - If it exists: run `rmdir <config.output_dir>/batches/<batch-key>.lock/`
   - Print: "Batch `<batch-key>` unlocked. Run `/taskflow:implement` to claim it."
   - Stop. Do not proceed to implementation.

4. Read the index file at `<config.output_dir>/state.<developer_slug>.json`:
   - If the file does not exist, stop: "No triage state found. Run `/taskflow:triage` first."
   - Parse the index to get the batch list and task classifications.

5. **Claim a batch:**

   **If a batch name was passed** (e.g., `/taskflow:implement batch-2`):
   - If that batch does not exist in the index, stop and list available batches.
   - Read `<config.output_dir>/batches/batch-2.json` — if `status` is `"pr-created"` or `"done"`, stop: "Batch 2 is already complete."
   - Check if `<config.output_dir>/batches/batch-2.lock/` exists:
     - If yes: stop: "Batch 2 is already claimed by another session. Use `--unlock batch-2` to release it if the session crashed."
     - If no: run `mkdir <config.output_dir>/batches/batch-2.lock/`. If mkdir fails, stop with the same "already claimed" message.
   - Read `batch-2.json` and proceed.

   **If no argument was passed** (`/taskflow:implement`):
   - Iterate through batches in key order (batch-1, batch-2, ...):
     - If `<config.output_dir>/batches/<batch-key>.lock/` exists → skip (claimed)
     - Read `<config.output_dir>/batches/<batch-key>.json` — if `status` is `"pr-created"` or `"done"` → skip (complete)
     - Try: `mkdir <config.output_dir>/batches/<batch-key>.lock/`
     - If mkdir succeeds → claimed. Read the batch file and proceed.
     - If mkdir fails (race condition) → skip, try next batch.
   - If no batch could be claimed: stop: "No available batches. All are either claimed, complete, or not yet triaged."

6. Read plan files for each task in the claimed batch:

   ```
   <config.output_dir>/tasks/<task-id>.md
   ```

   - If a plan file does not exist, warn: "Plan file missing for task `<task-id>`. Skipping — re-run /taskflow:triage to regenerate."
   - If it exists, read it fully.

7. Validate that referenced files still exist (same as before — check "Files Involved" paths).

8. Check task status in the provider:
   - Call `get_task(id)` for each task.
   - If a task is no longer `todo`, skip it. Update its status to `"stale"` in the **batch file** (not the index).
   - If ALL tasks are stale, stop. Mark the batch as `"stale"` in its batch file. Remove the lock: `rmdir <config.output_dir>/batches/<batch-key>.lock/`.

9. **Move valid tasks to "in progress" in the provider:**
   - Call `update_task(id, {status: "in_progress"})` for each valid task.
   - Update the task's `status` to `"in-progress"` in the **batch file**.
   - Update the batch's `status` to `"in-progress"` in the **batch file**.
   - Write the updated **batch file** to disk immediately.
````

- [ ] **Step 4: Update all state file references in Steps 3-8**

Search the implement SKILL.md for every reference to "state file" or "the state file" in Steps 3 through 8. Replace each with "the batch file" or "the batch file (`batches/<batch-key>.json`)".

Specific locations to update:
- **Step 3** (Worktree): "Update the state file" → "Update the batch file"
- **Step 4b**: "Set the task's status to `"in-progress"` in the state file" → "in the batch file"
- **Step 4f**: "Append the SHA to the task's `commit_shas` array in the state file" → "in the batch file"
- **Step 6**: mentions recording in state file → record in batch file
- **Step 7**: "Update the state file" → "Update the batch file". Set `pr_url` on each task in the batch file. Set batch status to `"pr-created"` in the batch file.
- **Step 8**: "state file" references in the terminal summary output

Also update Step 3 branch naming: the batch now has `suggested_branch` from the index, not `branch`. The implement skill should use `suggested_branch` from the index as the starting point for the branch name, then write the confirmed `branch` to the batch file.

- [ ] **Step 5: Update Error Recovery section**

Find the "Error Recovery" section. Update all "state file" references to "batch file":

- "Already-committed tasks remain in their branches with `status: "committed"` in the **batch file**"
- "The batch's `status` stays as `"in-progress"` in the **batch file**"
- "Re-running `/taskflow:implement <batch-name>` will detect the lock and offer to resume" — update this since the lock already exists. New behavior: if the lock exists AND the batch was explicitly requested, check if this is a resume scenario. Read the batch file — if `status` is `"in-progress"`, ask: "This batch is in progress (lock exists). Resume? [Y/n]". If yes, proceed from first uncommitted task. If no argument was passed, skip locked batches as normal.

Add a new error recovery section:

```markdown
### Batch claim with existing lock (resume scenario)

If `/taskflow:implement batch-N` is called and `batch-N.lock/` already exists:

- Read `batch-N.json` — check the `status`:
  - If `"in-progress"`: ask the developer: "Batch N is in progress (claimed by a previous session). Resume from where it left off? [Y/n]"
    - If yes: skip the mkdir step, proceed to Step 2 starting from the first task with `status` of `"planned"` or `"in-progress"` (not `"committed"`)
    - If no: stop. Tell the developer to use `--unlock batch-N` first.
  - If `"pending"`: the lock is stale (claim happened but no work started). Ask: "Batch N has a stale lock. Remove it and reclaim? [Y/n]"
    - If yes: `rmdir` the lock, then `mkdir` to reclaim, proceed normally.
    - If no: stop.
  - If `"pr-created"`: stop: "Batch N is already complete."
```

- [ ] **Step 6: Replace the State File Fields table**

Find the "State File — Fields Written by `/taskflow:implement`" section. Replace it entirely with:

```markdown
## Batch File — Fields Written by `/taskflow:implement`

`/taskflow:triage` creates the batch files. `/taskflow:implement` fills in these fields during a run:

| Field            | Written when                                          |
| ---------------- | ----------------------------------------------------- |
| `status`         | `"in-progress"` at claim, `"pr-created"` at Step 7    |
| `branch`         | When worktree is created (Step 3)                     |
| `pr_url`         | After PR is created (Step 7)                          |
| `tasks.<id>.status`      | `"in-progress"` at Step 4b, `"committed"` at Step 4f |
| `tasks.<id>.commit_shas` | After each task commit (Step 4f)                     |

The index file (`state.<developer_slug>.json`) is **never** written by `/taskflow:implement`.
```

- [ ] **Step 7: Update Output File Locations Reference table**

Find the output file locations table. Replace with:

```markdown
| File           | Path                                                                  |
| -------------- | --------------------------------------------------------------------- |
| Config file    | `.claude/taskflow-config.json`                                        |
| Index file     | `<config.output_dir>/state.<developer_slug>.json`                     |
| Batch files    | `<config.output_dir>/batches/<batch-key>.json`                        |
| Batch locks    | `<config.output_dir>/batches/<batch-key>.lock/` (directory)           |
| Per-task plan  | `<config.output_dir>/tasks/<task-id>.md`                              |
| Worktree       | `../<config.project_name>-<branch-name>/` (sibling of project root)   |
```

- [ ] **Step 8: Commit**

```bash
cd /home/rentorious/dev/taskflow && git add skills/implement/SKILL.md && git commit -m "refactor: parallel-safe batch claiming and per-batch state files"
```

---

### Task 4: Push and Update Plugin

**Files:** None (git operations only)

- [ ] **Step 1: Push to GitHub**

```bash
cd /home/rentorious/dev/taskflow && git push
```

- [ ] **Step 2: Bump version**

Update `/home/rentorious/dev/taskflow/.claude-plugin/plugin.json` — change version from `"1.0.1"` to `"1.1.0"` (minor version bump for new feature).

Update `/home/rentorious/dev/taskflow/.claude-plugin/marketplace.json` — change version to `"1.1.0"`.

- [ ] **Step 3: Commit and push version bump**

```bash
cd /home/rentorious/dev/taskflow && git add .claude-plugin/ && git commit -m "chore: bump to 1.1.0 — parallel-safe implementation" && git push
```

- [ ] **Step 4: Update local installation**

```bash
claude plugins marketplace update taskflow-local && claude plugins update taskflow@taskflow-local
```
