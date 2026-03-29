---
name: triage
description: Use when asked to triage project management tasks, process task lists, plan task batches, or when user invokes /taskflow:triage. Fetches to-do tasks, classifies them, creates implementation plans, and groups into smart batches.
---

# Taskflow Triage (`/taskflow:triage`)

Pull, classify, plan, and batch tasks from your project management tool for the current developer. Produces per-task implementation plan files, a state file for `/taskflow:implement` to consume, and a human-readable summary.

All behavior is driven by `.claude/taskflow-config.json` — no provider-specific details appear in the main workflow. Provider-specific MCP tool mappings are in the appendix at the bottom of this document.

## Invocation

```
/taskflow:triage              # Triage all to-do tasks assigned to you
/taskflow:triage --force      # Re-triage already-triaged tasks (rewrite plans, reclassify)
```

---

## Prerequisites

Before starting, verify:

1. **Config file exists** at `.claude/taskflow-config.json` — if not, stop immediately:
   > "No taskflow config found. Run `/taskflow:setup` first."

2. **Provider MCP server is connected** — check for the MCP tools that match `config.provider` (e.g., ClickUp tools start with `clickup_`). If the tools are not available, stop:
   > "Provider MCP server (`<config.provider>`) is not connected. Check your MCP configuration."

3. **Developer identity is in Claude memory** (full name + provider user ID)

**If developer identity is missing from memory:**

- Ask: "I don't have your identity saved. What's your full name?"
- Use `find_member(name)` to look up their provider user ID
- Confirm the ID with the developer
- Save name and provider user ID to Claude memory before proceeding

---

## Step-by-Step Process

Follow these steps in order. Do not skip or reorder steps.

---

### Step 1: Load Context

1. Read `.claude/taskflow-config.json` — parse fully. Store the entire config object for use throughout the workflow.

2. Read developer identity from Claude memory:
   - Full name (e.g., "Ognjen Popovic")
   - Provider user ID (e.g., "96691755")
   - Derive `developer_slug`: first name, lowercase (e.g., "ognjen")

3. Read provider config: `config[config.provider]` — extract workspace info and lists.

4. Determine target list(s): use the list(s) where `default: true` unless the user specified a different list. If multiple lists are marked default, use all of them.

5. Check for existing state file at:

   ```
   <config.output_dir>/state.<developer_slug>.json
   ```

   - If it exists, parse it and load the `tasks` map
   - Note which task IDs already have `status: "planned"`, `"in-progress"`, `"pr-created"`, or `"done"` — these are "already triaged"
   - If `--force` was passed: ignore the already-triaged set (re-triage everything)
   - If `--force` was NOT passed: keep the already-triaged set — you will skip these in Step 2

6. Note today's date in `YYYY-MM-DD` format for use in output filenames.

---

### Step 2: Fetch Tasks

1. For each target list, call `fetch_tasks(list_id, "todo", developer_id)` to retrieve tasks with "to do" status assigned to the current developer.

2. Merge results from all lists and deduplicate by task ID.

3. For each returned task, call `get_task(id)` to retrieve full details:
   - Title (`name`)
   - Description — may be empty
   - Task URL
   - Status, assignees, tags
   - Attachments — note whether attachments are present (you cannot view image content, only their existence)

4. For each task, call `get_comments(id)` to retrieve comment content — may reveal additional context.

5. **Filter already-triaged tasks** (when not using `--force`):
   - Cross-reference each returned task ID against the already-triaged set from the state file
   - Separate into two lists:
     - `new_tasks`: task IDs not in state file, or with `status: null`
     - `stale_check`: task IDs currently in state file — verify their provider status is still `todo`
   - For `stale_check` tasks: if their status has changed away from `todo` (e.g., moved to `in_progress`, `in_review`, or `done`), mark them as `stale` in the state file and exclude from triage
   - Only triage `new_tasks` (and all tasks if `--force`)

6. If the merged task list is empty or returns no tasks:
   - Print: "No to-do tasks assigned to you in the configured list(s)."
   - Stop execution.

7. If after filtering there are zero tasks to triage, report:
   - "All assigned to-do tasks are already triaged. Use `/taskflow:triage --force` to re-triage."
   - Still update stale task statuses in the state file and stop.

---

### Step 3: Classify Each Task (Parallel Agents)

For each task that needs triage, dispatch one classification agent using the Agent tool. Run all agents in parallel — do not wait for one to finish before starting the next.

**Input each agent receives:**

- Task ID
- Task title
- Task description (may be empty)
- Comment content (if any)
- Whether attachments are present (and count)
- The classification schema and rules below
- The `config.areas` and `config.extra_areas` from the config file

**Each agent must search the codebase and return a classification object:**

```json
{
  "task_id": "<id>",
  "area": "<area from config>",
  "type": "bug|feature|copy-change|investigation",
  "complexity": "small|medium|large",
  "confidence": "high|medium|low",
  "implementable": "yes|partial|no",
  "summary": "One-paragraph description of what needs to be done, in plain language.",
  "unclear": "What information is missing or ambiguous. null if confidence is high.",
  "files": ["relative/path/to/relevant/file.ts"],
  "approach": "Step-by-step description of how to implement this.",
  "time_estimate_human": "Estimated time for a human developer familiar with the codebase (e.g., '30 min', '2 hours', '4-6 hours').",
  "time_estimate_agent": "Estimated time for an AI coding agent with full codebase access (e.g., '10 min', '30 min', '1-2 hours')."
}
```

#### Time Estimate Guidelines

Estimates must reflect the **specific task**, not just the complexity bucket. A one-line `replaceAll` fix and a tricky state-management bug are both "small" but have very different time profiles. Use the ranges below as hard bounds — place your estimate within them based on the number of files touched, whether debugging/investigation is needed, whether external systems are involved, and how much edge-case handling the approach requires.

**Human estimates** — developer who knows the codebase, includes context-switching and manual testing:

- `small` complexity: 15 min – 1 hour
- `medium` complexity: 1 – 4 hours
- `large` complexity: 4 – 8+ hours

**Agent estimates** — AI agent with instant codebase access, no context-switch cost, human review after:

- `small` complexity: 5 – 15 min
- `medium` complexity: 15 min – 1 hour
- `large` complexity: 1 – 3 hours

Bump toward the top of the range (or beyond for large) when: investigation is needed before implementation, visual verification is required, external systems must be changed (third-party dashboards, email templates), or the approach has significant unknowns.

#### Classification Rules

**`area`** — Where the change lives:

Area options come from two sources:
- **Code areas:** the keys of `config.areas` (e.g., `"storefront"`, `"admin"`, `"backend"`, `"common"`)
- **Non-code areas:** the values in `config.extra_areas` (e.g., `"sendgrid"`, `"manual"`)

For each code area, use `config.areas[area].description` to understand what it covers, and search the directories listed in `config.areas[area].paths` to find relevant files.

Rules:
- Assign a non-code extra area (e.g., `"manual"`) for tasks that cannot be done in code — data entry, content in a CMS, admin UI data changes, non-code configuration. Set `implementable: no` for these.
- If a task spans multiple areas (e.g., backend API change + storefront UI change), pick the primary area and note the secondary area in `summary`. Set complexity to at least `medium`.

**`type`**:

- `bug`: Something is broken, erroring, or not working as expected. A regression.
- `feature`: New functionality that doesn't exist yet.
- `copy-change`: Text or content update — labels, headings, descriptions, error messages. Usually `small` complexity.
- `investigation`: Needs research or testing before implementation can be scoped. No clear solution known. Assign `confidence: low` and `complexity: medium` minimum.

**`complexity`**:

- `small`: Single file or component, obvious fix, under ~1 hour. Routine change.
- `medium`: Multiple files or components, moderate logic, 1–4 hours.
- `large`: Architectural change, new feature spanning many files, significant logic, database migrations, 4+ hours.

**`confidence`**:

- `high`: Task description is clear, the affected code is findable in the codebase, the approach is obvious.
- `medium`: General intent is clear but some ambiguity — e.g., which specific component, exact behavior expected, edge cases.
- `low`: Insufficient information. No description + only a screenshot attachment, vague title, task requires visual context you cannot access, or deeply ambiguous requirements.

**`implementable`**:

- `yes`: Fully implementable via code changes only.
- `partial`: Code changes needed + manual steps outside code (e.g., update a template in an external dashboard, enter data in the admin, update a third-party config).
- `no`: Entirely manual — no code changes needed or possible.

#### Codebase Search Instructions for Agents

For each area, search the directories listed in `config.areas[area].paths`. Use these heuristics:

- Look for pages, components, hooks, styles, and API utility calls in frontend areas
- Look for API routes, services, models, subscribers, and migrations in backend areas
- Look for shared types and DTOs in shared/common areas
- Check for references to external services (email template IDs, third-party API calls) in subscriber and service directories

When searching, use keyword matching on component names, route paths, UI labels, or feature names extracted from the task title. If the task mentions a specific UI element by name, search for that string in the relevant area's paths.

#### Special Case: Screenshot-only Tasks

If a task has:

- An empty or near-empty description (title only), AND
- One or more attachments (likely a screenshot)

Assign `confidence: low` regardless of other signals. You cannot view image attachments through the MCP. Make a best-effort guess at what the screenshot might show based on the task title, but do not fabricate specifics.

---

### Step 4: Enrich Task Descriptions

After classification, update each task in the provider based on confidence level.

**Important voice guidelines — the enrichment must sound like the developer wrote it, not an AI:**

- Write in first person if helpful ("Need to check...", "Looks like...", "This is probably...")
- Use short sentences, conversational tone
- No bullet-pointed "Summary of changes" headers
- No phrases like "This task involves...", "Upon analysis...", "As per the requirements..."
- Be technical and direct — mention file names, component names, service names where known

**For `confidence: high` tasks:**
Call `update_task(id, {description: ...})` to update the task description. Include:

- What's broken or what needs to be built (1–2 sentences)
- Which part of the codebase is involved (component name, service name, route path)
- The intended approach (concise)

Example enrichment:

> "Pagination on the inventory finder is capping at 25 results. The issue is in the `InventoryList` component — the query param is hardcoded to `limit: 25`. Need to read the total count from the API response and thread it through to the pagination component."

**For `confidence: medium` tasks:**
Call `update_task(id, {description: ...})` to update the description with best-guess context. Include what's clear and flag what's uncertain in-line.

Example:

> "Something's off with the cart totals when a discount is applied. Not sure if it's the discount calculation in `TotalsService` or how the storefront is displaying it — need to test both paths."

**For `confidence: low` tasks:**

1. Call `update_task(id, {description: ...})` with whatever context CAN be determined from the title alone
2. Call `add_comment(id, ...)` to ask for clarification in the developer's voice

Example clarification comment:

> "Hey Derek, the description didn't come through on this one — just a screenshot and I can't pull up images through my tooling. Can you describe what you're seeing? Which page is this on and what's the expected behavior?"

Adjust the comment tone to match what the developer would actually write. If the task creator's name is known, use it in the greeting.

---

### Step 5: Create Implementation Plan Files

For each task (including `implementable: no` tasks), write a plan file to:

```
<config.output_dir>/tasks/<task-id>.md
```

Create the `<config.output_dir>/tasks/` directory if it does not exist.

**Plan file format:**

```markdown
# <Task Title>

**Task:** <task_url>
**Area:** <area> | **Type:** <type> | **Complexity:** <complexity> | **Confidence:** <confidence>
**Time Estimate (Human):** <time_estimate_human> | **Time Estimate (Agent):** <time_estimate_agent>

## What Needs to Change

<summary from classification — plain English description of what's broken or needs building>

## Files Involved

- `path/to/file.ts` — what changes in this file
- `path/to/other.ts` — what changes in this file

## Approach

<Numbered step-by-step implementation plan. Be specific enough that another developer or agent can follow it without additional context. Reference function names, component names, or API endpoints where known.>

## Risks / Unknowns

<Anything that could go wrong, decisions that need to be made, or things that need verification before or during implementation. Write "None identified." if genuinely clear.>

## Manual Steps (if partial)

<Steps the developer must take outside of code — e.g., "Update the email template in the external dashboard to change the subject line". Write "N/A" if implementable: yes.>

## Dependencies

<Other task IDs that should be implemented first, with a brief reason. Write "None." if independent.>
```

**For `implementable: no` tasks**, use this condensed format:

```markdown
# <Task Title>

**Task:** <task_url>
**Area:** <area> | **Type:** manual | **Complexity:** <complexity> | **Confidence:** <confidence>
**Implementable:** No — manual task

## What Needs to Happen

<Description of the manual work required.>

## Why Not Automated

<Brief reason — e.g., "Requires data entry in the admin dashboard", "Email template UI change with no code equivalent", "Content update in an external system".>
```

Write all plan files to disk before moving to Step 6.

---

### Step 6: Group Tasks into Batches

Create batch groupings from the classified tasks. Apply these rules in order:

**Rule 1 — Exclude non-implementable tasks from batches:**
Tasks with `implementable: no` go into a separate "manual" group. They are listed in the summary but assigned `batch: null` in the state file.

**Rule 2 — Group by relatedness first:**
Tasks that touch the same feature area, the same files, or are clearly part of the same user-facing concern belong in the same batch. For example: multiple email template issues -> one batch; multiple storefront product page issues -> one batch.

**Rule 3 — Then apply complexity limits per batch:**

- Max 5 `small` tasks per batch
- Max 3 `medium` tasks per batch
- `large` tasks: always isolated — one large task = one batch, never combined
- Mixed small + medium: treat as medium rules (max 3 total)

**Rule 4 — Low-confidence tasks can be batched but are flagged:**
Do not isolate them just because confidence is low. They will be reviewed by the developer before `/taskflow:implement` starts on them.

**Rule 5 — Name each batch descriptively:**
Pick a batch name that describes what the batch accomplishes, e.g.:

- "Email template fixes"
- "Product page UI bugs"
- "Inventory search improvements"
- "Admin order management features"

---

### Step 7: Write State File

Write the state file to `<config.output_dir>/state.<developer_slug>.json`.

**If a state file already existed (re-triage run):** Merge the new data:

- Preserve existing task entries that were not re-triaged (kept from state file)
- Update entries for tasks that were re-triaged
- Update stale task statuses
- Merge new tasks into the `tasks` map
- Rebuild the `batches` map to reflect all current batches (new + any existing pending/in-progress batches that were not touched)

**State file schema:**

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
      "batch": "<batch-1|batch-2|null>",
      "status": "planned",
      "branch": null,
      "pr_url": null,
      "commit_shas": []
    }
  },
  "batches": {
    "batch-1": {
      "name": "<human-readable batch description>",
      "branch": null,
      "tasks": ["<task-id-1>", "<task-id-2>"],
      "status": "pending"
    }
  }
}
```

Field notes:

- `status` for new tasks: always `"planned"`
- `branch`, `pr_url`, `commit_shas`: always null/empty for newly triaged tasks — `/taskflow:implement` fills these in
- `batch`: `null` for manual/non-implementable tasks
- Batch `status`: always `"pending"` for new batches

---

### Step 8: Write Summary File

Write a human-readable summary to:

```
<config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md
```

**Summary file format:**

```markdown
# Triage Summary — <Developer Full Name> — YYYY-MM-DD

## Batches

### Batch 1: <Batch Name>

- **Tasks:** <count> | **Overall Complexity:** <small|medium|large> | **Suggested Branch:** `<branch-name>`
- [ ] <Task Title> (`<task-id>`) — <one-line summary of what needs to change>
- [ ] <Task Title> (`<task-id>`) — <one-line summary>

### Batch 2: <Batch Name>

...

## Manual Tasks (not batched)

- <Task Title> (`<task-id>`) — <why it's manual / what needs to be done manually>

## Low Confidence Tasks (need clarification before implementing)

- <Task Title> (`<task-id>`) — <what's unclear, what clarification was requested>

## Stats

- **Total tasks fetched:** <n>
- **New tasks triaged:** <n>
- **Skipped (already triaged):** <n>
- **Stale (moved out of to-do):** <n>
- **Implementable:** <n> | **Partial:** <n> | **Manual:** <n>
- **Batches created:** <n>
- **Low confidence tasks:** <n>
```

For the suggested branch name in each batch, use `config.branch_conventions` to determine the prefix:

- Look up the task type (bug, feature, chore, refactor) in `config.branch_conventions` to get the prefix (e.g., `"fix/"`, `"feat/"`, `"chore/"`)
- If a batch contains mixed types, use the convention for the dominant type
- Append a descriptive kebab-case suffix (e.g., `fix/email-template-bugs`, `feat/admin-order-features`)

---

### Step 9: Print Terminal Summary

After writing files, print the summary content directly to the terminal so the developer can review it without opening files.

Then print the file locations:

```
State file:   <config.output_dir>/state.<developer_slug>.json
Summary file: <config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md
Plan files:   <config.output_dir>/tasks/<task-id>.md (one per task)
```

---

## Re-triage Merge Behavior

When `/taskflow:triage` is run again on an existing state file (without `--force`):

| Scenario                                                                                 | Action                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Task is new (not in state file)                                                          | Add and triage normally                                               |
| Task is in state file with `status: planned` and still `todo` in the provider            | Skip (already triaged)                                                |
| Task is in state file with `status: in-progress` or `pr-created`                         | Skip — do not re-triage in-flight work                                |
| Task is in state file but no longer `todo` in the provider (moved to another status)     | Mark `status: stale` in state file; remove from its batch's task list |
| Batch loses all tasks due to staleness                                                   | Remove the batch from state file                                      |

When `/taskflow:triage --force` is run:

- Re-triage all `todo` tasks, including already-planned ones
- Overwrite their plan files with fresh classification
- Rebuild batches from scratch
- Preserve `in-progress` and `pr-created` task entries — do not re-triage or re-batch tasks actively being implemented

---

## Output File Locations Reference

| File          | Path                                                                |
| ------------- | ------------------------------------------------------------------- |
| State file    | `<config.output_dir>/state.<developer_slug>.json`                   |
| Summary file  | `<config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md`      |
| Per-task plan | `<config.output_dir>/tasks/<task-id>.md`                            |

All paths are relative to the project root. Use absolute paths when writing files.

---

## Error Handling

**Provider API errors:**

- If `fetch_tasks` fails: stop and report the error. Do not proceed with stale cached data.
- If `get_task` fails for an individual task: note the failure, skip that task, and continue with others. List skipped tasks in the terminal summary.
- If `update_task` fails for a task: note the failure and continue. The plan file still gets written.
- If `add_comment` fails: note the failure and continue. Comments are not blocking.

**Missing memory:**

- If developer identity is not in memory: ask before proceeding (see Prerequisites section).

**Empty or minimal task descriptions:**

- Never skip a task because its description is empty. Classify it at `confidence: low` and proceed.
- The plan file still gets written with whatever can be inferred from the title.

---

## Provider Appendix: ClickUp

Use this section when `config.provider` is `"clickup"`.

### MCP Tool Mapping

| Normalized Operation | ClickUp MCP Tool | Notes |
|---------------------|-------------------|-------|
| `fetch_tasks(list_id, status, assignee_id)` | `clickup_filter_tasks` | Pass `list_ids: [list_id]`, `statuses: [status]`, `assignees: [assignee_id]` |
| `get_task(id)` | `clickup_get_task` | Pass `task_id: id` |
| `get_comments(id)` | `clickup_get_task_comments` | Pass `task_id: id` |
| `update_task(id, fields)` | `clickup_update_task` | Pass `task_id: id` + field overrides |
| `add_comment(id, text)` | `clickup_create_task_comment` | Pass `task_id: id`, `comment_text: text` |
| `find_member(name)` | `clickup_find_member_by_name` | Pass `name: name` |

### Status Mapping

| Normalized | ClickUp Status |
|-----------|----------------|
| `todo` | `to do` |
| `in_progress` | `in progress` |
| `in_review` | `code review` |
| `done` | `done` |
| `cancelled` | `cancelled` |

### ClickUp-Specific Notes

- Task URLs follow the pattern: `https://app.clickup.com/t/<task_id>`
- `clickup_filter_tasks` returns tasks with `name`, `id`, `status.status`, `url`, and `assignees` array
- Comments are retrieved separately via `clickup_get_task_comments`
- Attachments are noted on the task object but image content cannot be viewed through MCP
