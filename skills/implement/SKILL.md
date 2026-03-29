---
name: implement
description: Use when asked to implement task batches, execute triaged tasks, or when user invokes /taskflow:implement. Reads triage state, creates git worktrees, implements changes, runs tests, and creates PRs.
---

# Taskflow Implement (`/taskflow:implement`)

Read triage output from `/taskflow:triage`, create a git worktree, implement all tasks in a batch, verify the build, update the project management provider, push the branch, and open a PR.

All behavior is driven by `.claude/taskflow-config.json` — no provider-specific details appear in the main workflow. Provider-specific MCP tool mappings are in the appendix at the bottom of this document.

## Invocation

```
/taskflow:implement              # Implement next pending batch
/taskflow:implement batch-2      # Implement a specific batch by name
```

---

## Prerequisites

Before starting, verify:

1. **Config file exists** at `.claude/taskflow-config.json` — if not, stop immediately:
   > "No taskflow config found. Run `/taskflow:setup` first."

2. **Provider MCP server is connected** — check for the MCP tools that match `config.provider` (e.g., ClickUp tools start with `clickup_`). If the tools are not available, stop:
   > "Provider MCP server (`<config.provider>`) is not connected. Check your MCP configuration."

3. **Developer identity is in Claude memory** (full name + provider user ID)

4. **State file exists** at `<config.output_dir>/state.<developer_slug>.json` — if not, stop:
   > "No triage state found. Run `/taskflow:triage` first."

5. **`gh` CLI is authenticated** and available (`gh auth status`)

---

## Step-by-Step Process

Follow these steps in order. Do not skip or reorder steps.

---

### Step 1: Load State and Validate

1. Read `.claude/taskflow-config.json` — parse fully. Store the entire config object for use throughout the workflow.

2. Read developer identity from Claude memory:
   - Full name (e.g., "Ognjen Popovic")
   - Provider user ID
   - Derive `developer_slug`: first name, lowercase (e.g., "ognjen")

3. Read the state file at:

   ```
   <config.output_dir>/state.<developer_slug>.json
   ```

   - If the file does not exist, stop and print:
     > "No triage state found. Run /taskflow:triage first."

4. Determine the target batch:
   - If a batch name was passed as an argument (e.g., `/taskflow:implement batch-2`): use that batch. If it does not exist in the state file, stop and list available batches.
   - If no argument was passed: find the first batch with `status: "pending"` (by batch key order: batch-1 before batch-2, etc.).
   - If no pending batches exist, stop and print:
     > "No pending batches. All work is either in-progress, complete, or not yet triaged."

5. Read plan files for each task in the target batch:

   ```
   <config.output_dir>/tasks/<task-id>.md
   ```

   For each plan file:
   - If the file does not exist, warn: "Plan file missing for task `<task-id>`. Skipping this task — re-run /taskflow:triage to regenerate it."
   - If the file exists, read it fully.

6. Validate that referenced files still exist:
   - For each file listed in the plan's "Files Involved" section, check whether the path exists in the repo.
   - If one or more files have moved or been deleted, warn the developer:
     > "Warning: `<path>` no longer exists. This plan may be stale. Consider re-running /taskflow:triage --force for this task before implementing."
   - Offer to continue anyway or abort. Wait for the developer's response before proceeding.

7. Check task status in the provider for each task in the batch:
   - Call `get_task(id)` for each task ID.
   - If a task's provider status is no longer `todo` (e.g., it moved to `in_review`, `done`, `cancelled`), skip it and note:
     > "Task `<name>` (`<id>`) is now `<status>` in the provider — skipping."
   - Update that task's `status` to `"stale"` in the state file.
   - If ALL tasks in the batch are stale or invalid, stop and mark the batch as `"stale"` in the state file.

8. **Move all valid batch tasks to "in progress" in the provider:**
   - For each task that passed validation (not stale, not skipped), call `update_task(id, {status: "in_progress"})`.
   - Update the task's `status` to `"in-progress"` in the local state file.
   - Update the batch's `status` to `"in-progress"` in the local state file.
   - Write the updated state file to disk immediately, before beginning implementation.
   - If a status update fails for a task, note it and continue — do not block implementation.

---

### Step 2: Handle Low-Confidence Tasks

For each task where `classification.confidence` is `"low"`:

1. Show the developer:
   - Task title and task URL
   - The "Risks / Unknowns" section from the plan file
   - What's unclear (from the `unclear` field in the classification)

2. Ask:

   > "This task is low confidence. How would you like to proceed?
   > (a) Attempt implementation with best guess
   > (b) Skip this task for now
   > (c) Provide more context before I start"

3. Wait for a response before proceeding. Do not guess or auto-continue.

4. Based on the response:
   - `(a)`: Proceed with implementation, note it was flagged low-confidence.
   - `(b)`: Exclude this task from the current run. Leave its state as `"planned"` in the state file. Continue with remaining tasks. If all tasks in the batch are skipped, stop.
   - `(c)`: Incorporate the context the developer provides, update the plan file's "Approach" and "Risks / Unknowns" sections with the new information, then proceed.

---

### Step 3: Create Git Worktree

1. Determine the branch name based on the batch content:

   Use `config.branch_conventions` to determine the prefix for the dominant task type:

   | Batch content                       | Look up prefix in `config.branch_conventions` for: |
   | ----------------------------------- | -------------------------------------------------- |
   | Single bug fix                      | `bug` key                                          |
   | Single new feature                  | `feature` key                                      |
   | Batch of small fixes / copy changes | `chore` key                                        |
   | Multiple related bug fixes          | `bug` key                                          |
   | Multiple related features           | `feature` key                                      |
   | Refactoring tasks                   | `refactor` key                                     |

   Rules for the name portion:
   - Kebab-case only (lowercase, hyphens, no spaces or special characters)
   - Under 50 characters total (including prefix)
   - Derived from the batch's human-readable name or the dominant task title
   - Examples: `fix/cart-discount-totals`, `feat/inventory-search-filters`, `chore/storefront-copy-fixes`

2. Create the worktree from `origin/<config.base_branch>`:

   ```bash
   git worktree add -b <branch-name> ../<config.project_name>-<branch-name> origin/<config.base_branch>
   ```

   - If the branch already exists locally (e.g., a previous aborted run), use:
     ```bash
     git worktree add ../<config.project_name>-<branch-name> <branch-name>
     ```
   - The worktree directory is created as a sibling of the repo root (e.g., `/path/to/dev/<config.project_name>-fix-cart-discount-totals`).

3. Update the state file immediately after worktree creation:
   - Set the batch's `branch` field to `<branch-name>`
   - Set the batch's `status` to `"in-progress"`

4. Install dependencies in the worktree:

   ```bash
   cd <worktree-path> && <config.install_command>
   ```

   If the install command fails, stop and report the error. Do not proceed with a broken install.

5. Run pre-implementation build commands — execute each command in `config.build_before_implement` in order:

   ```bash
   cd <worktree-path> && <config.build_before_implement[0]>
   cd <worktree-path> && <config.build_before_implement[1]>
   ...
   ```

   If any build command fails, stop and report the error.

---

### Step 4: Implement Changes

Work from the worktree directory for all commands in this step.

For each task in the batch (in the order they appear in `batches.<batch-key>.tasks`):

#### 4a. Read and internalize the plan

Re-read the plan file for the task. Understand:

- What files need to change
- The step-by-step approach
- Any risks or unknowns noted

#### 4b. Update task status in state file

Set the task's `status` to `"in-progress"` in the state file.

#### 4c. Implement the changes

Follow the plan's "Approach" section.

#### Implementation Conventions

Follow the project's coding conventions as documented in the project's CLAUDE.md file. CLAUDE.md is automatically loaded into your context — do not duplicate its rules here.

If no CLAUDE.md exists or it lacks convention guidance, follow standard practices for the project's tech stack as detected from the codebase.

#### 4d. Run checks after each task

After completing the implementation for a task, run checks before committing. Determine which area(s) were touched based on the files changed and the `config.areas` mapping.

For each affected area, run the configured checks in this order:

1. **Build** (if defined): run `config.areas[area].build` first. If it fails, fix the issue before proceeding.

2. **Lint** (if defined): run `config.areas[area].lint`. Skip if null or not defined in the config.

3. **Typecheck** (if defined): run `config.areas[area].typecheck`. Skip if null or not defined in the config.

4. **Tests** (if defined): run `config.areas[area].test`. Skip if null or not defined in the config. Only run if a test file exists that covers the changed code, or if the area has a general test suite.

All commands are run from the worktree directory.

**Fixing failures:**

- If lint or type-check fails: fix the issues before committing. Do not commit with known lint or type errors.
- If tests fail: diagnose the failure. If it is caused by your changes, fix it. If it appears to be a pre-existing failure unrelated to your changes, note it explicitly and continue — do not block on pre-existing failures.
- If you cannot fix a failure after two attempts, stop and report the specific error to the developer. Ask how to proceed.

#### 4e. Commit the task

After all checks pass for this task:

```bash
cd <worktree-path> && git add <specific-files-changed> && git commit -m "<type>: <description>"
```

Commit message rules:

- Type prefix must be one of: `fix:`, `feat:`, `chore:`, `refactor:`, `style:`
- Use `fix:` for bugs, `feat:` for new functionality, `chore:` for copy changes or non-functional updates, `refactor:` for restructuring, `style:` for formatting/visual changes
- Description: present tense, under 72 characters total
- Stage specific files only — never `git add .` or `git add -A`
- Examples:
  - `fix: cap inventory search results at correct page total`
  - `feat: add bloom color filter to plant finder`
  - `chore: update cart empty state copy`

#### 4f. Record commit SHA in state file

After a successful commit:

- Run `git rev-parse HEAD` to get the SHA
- Append the SHA to the task's `commit_shas` array in the state file
- Set the task's `status` to `"committed"`

Repeat steps 4a–4f for each remaining task in the batch. All tasks commit to the same branch.

---

### Step 5: Run Full Verification

After all tasks in the batch are committed, run full verification from the worktree directory:

1. **Full lint** (if defined): run `config.full_lint`. Skip if null or not defined in the config.

2. **Full typecheck** (if defined): run `config.full_typecheck`. Skip if null or not defined in the config.

3. **Relevant test suites:** re-run `config.areas[area].test` for each area that was touched during the batch. Skip areas where the test command is null or not defined.

**If ANY check fails:**

- Do NOT push the branch
- Report the exact failure output to the developer
- Attempt to fix the failure. If you fix it, re-commit the fix and re-run all checks.
- If you cannot fix it after two attempts, stop and keep the batch status as `"in-progress"` in the state file. Ask the developer for guidance.

Only proceed to Step 6 when all checks pass cleanly.

---

### Step 6: Update Provider

For each task in the batch (including any that were already committed from a previous partial run):

1. **Move task status to `in_review`:**

   ```
   update_task(id, {status: "in_review"})
   ```

2. **Add a comment in the developer's voice:**

   ```
   add_comment(id, "<comment>")
   ```

   The comment must:
   - Sound like the developer wrote it — conversational, direct, technical
   - Mention what was actually changed and where (component name, file, service name)
   - Include the PR URL once it is available (add it after Step 7 if the provider is called before the PR exists — see note below)
   - NOT sound AI-generated:
     - No bullet points listing "Summary of changes:"
     - No phrases like "This commit addresses...", "Upon review...", "As per the task description..."
     - No passive voice summaries

   Good examples:

   > "Fixed it — the pagination query was ignoring the total count from the API response and always defaulting to offset 25. Threaded the total through to the `<Pagination>` component. PR: <url>"

   > "Added the bloom color filter to the plant finder. It hooks into the existing search facet setup — just needed the filter key added to the filterable attributes list and a UI toggle in the filters component. PR: <url>"

   > "Updated the copy on the cart empty state — 'Your cart is empty' to 'Nothing here yet'. PR: <url>"

   **Note on PR URL:** If the provider is being updated before the PR is created (e.g., in a partial run), omit the PR URL from the comment initially. After Step 7 creates the PR, go back and add a follow-up comment with the PR URL only if the initial comment did not include it.

**If provider API is unavailable:**

- Print a warning: "Provider API unavailable — skipping status updates. Update tasks manually after this run."
- Continue with the rest of the steps. Do not block on provider failures.

---

### Step 7: Push and Create PR

1. Push the branch:

   ```bash
   cd <worktree-path> && git push -u origin <branch-name>
   ```

2. Create the PR using `gh`:

   ```bash
   gh pr create --title "<title>" --body "$(cat <<'EOF'
   ## Summary
   <1–3 bullet points describing what this PR changes>

   ## Tasks
   - [<Task Title>](<task-url>)
   - [<Task Title>](<task-url>)

   ## Test Plan
   - [ ] <specific verification step>
   - [ ] <specific verification step>
   - [ ] <specific verification step>
   EOF
   )"
   ```

   PR title rules:
   - Descriptive, under 70 characters
   - No ticket numbers — the task links are in the body
   - Present tense action: "Fix cart pagination limit", "Add bloom color filter to plant finder"

   PR body rules:
   - Summary: 1–3 bullets describing the changes. Be specific — mention component names, route paths, service names.
   - Tasks: link every task in the batch by title and URL
   - Test Plan: concrete steps to manually verify the changes work. Think from the perspective of a reviewer who knows the codebase but hasn't seen the diff.

3. Capture the PR URL from the `gh` output.

4. Update the state file:
   - Set `pr_url` on each task in the batch to the PR URL
   - Set the batch's `status` to `"pr-created"`

5. If provider comments from Step 6 did not include the PR URL, add a follow-up comment to each task now:
   ```
   add_comment(id, "PR: <url>")
   ```

---

### Step 8: Clean Up and Report

1. Return to the original working directory (the main repo root).

2. Do NOT remove the worktree automatically. The developer may want to review the changes or run the app locally. The worktree stays until the developer manually removes it.

3. Print a terminal summary:

   ```
   Batch complete: <batch-name>

   Branch:   <branch-name>
   PR:       <pr-url>
   Tasks:    <count> implemented

   Tasks:
     <task-title> (<task-id>) — <commit-sha-short>
     <task-title> (<task-id>) — <commit-sha-short>

   Worktree: <worktree-path>
   (Remove when done: git worktree remove ../<config.project_name>-<branch-name>)
   ```

---

## Error Recovery

### Mid-batch failure (commit succeeded for some tasks, not others)

If the process fails partway through a batch:

- Already-committed tasks remain in their branches with `status: "committed"` in the state file
- The batch's `status` stays as `"in-progress"`
- Re-running `/taskflow:implement <batch-name>` will detect committed tasks (non-null `commit_shas`) and skip re-implementing them — it resumes from the first uncommitted task

### Test failures that block push

If Step 5 (full verification) fails:

- Keep batch status as `"in-progress"`
- Do not push
- Report the exact failure to the developer
- Keep the worktree intact for the developer to inspect

### Provider API unavailable

- Proceed with all code changes and the PR
- Print: "Provider unavailable — skipped status updates. Move tasks to 'in review' manually and add the PR URL as a comment."
- Record the PR URL in the state file as normal

### Worktree already exists (from previous aborted run)

If the worktree directory already exists:

- Confirm with the developer before proceeding: "Worktree at `../<config.project_name>-<branch-name>` already exists. Resume from where we left off?"
- If yes: skip worktree creation and install command, proceed to Step 4 starting from the first task with `status: "planned"` or `"in-progress"` (not `"committed"`)
- If no: remove the existing worktree (`git worktree remove --force ../<config.project_name>-<branch-name>`), then start fresh

---

## State File — Fields Written by `/taskflow:implement`

`/taskflow:triage` creates the state file. `/taskflow:implement` fills in these fields during a run:

| Field                    | Written when                                         |
| ------------------------ | ---------------------------------------------------- |
| `batches.<batch>.branch` | Worktree created (Step 3)                            |
| `batches.<batch>.status` | `"in-progress"` at Step 3, `"pr-created"` at Step 7  |
| `tasks.<id>.status`      | `"in-progress"` at Step 4b, `"committed"` at Step 4f |
| `tasks.<id>.commit_shas` | After each task commit (Step 4f)                     |
| `tasks.<id>.pr_url`      | After PR is created (Step 7)                         |
| `tasks.<id>.branch`      | When worktree is created (Step 3)                    |

---

## Output File Locations Reference

| File          | Path                                                                  |
| ------------- | --------------------------------------------------------------------- |
| Config file   | `.claude/taskflow-config.json`                                        |
| State file    | `<config.output_dir>/state.<developer_slug>.json`                     |
| Per-task plan | `<config.output_dir>/tasks/<task-id>.md`                              |
| Worktree      | `../<config.project_name>-<branch-name>/` (sibling of project root)   |

All paths are relative to the project root unless otherwise noted.

---

## Provider Appendix: ClickUp

Use this section when `config.provider` is `"clickup"`.

### MCP Tool Mapping

| Normalized Operation | ClickUp MCP Tool | Notes |
|---------------------|-------------------|-------|
| `get_task(id)` | `clickup_get_task` | Pass `task_id: id` |
| `update_task(id, fields)` | `clickup_update_task` | Pass `task_id: id` + fields. Map status values per table below. |
| `add_comment(id, text)` | `clickup_create_task_comment` | Pass `task_id: id`, `comment_text: text` |

### Status Mapping

| Normalized | ClickUp Status |
|-----------|----------------|
| `todo` | `to do` |
| `in_progress` | `in progress` |
| `in_review` | `code review` |
| `done` | `done` |
| `cancelled` | `cancelled` |
