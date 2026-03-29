---
name: setup
description: Use when setting up taskflow for a new project, configuring task management integration, or when user invokes /taskflow:setup. Interactive wizard that generates .claude/taskflow-config.json.
---

# Taskflow Setup (`/taskflow:setup`)

Interactive wizard that generates `.claude/taskflow-config.json` for this project.

## Invocation

```
/taskflow:setup                 # Run setup for a new project
/taskflow:setup --reconfigure   # Start from scratch on existing config
```

---

## Prerequisites

Before starting, verify both of the following:

1. **MCP server connected** — At least one project management MCP server must be available. Check for available tools:
   - ClickUp tools start with `clickup_`
   - Jira tools would start with `jira_` (future)

2. **Git repository** — The current directory must be a git repo. Run `git rev-parse --is-inside-work-tree` to confirm.

**If no MCP server is detected:**
Stop immediately and print:
> "No project management MCP server detected. Install the ClickUp MCP server and try again."

**If not a git repo:**
Stop immediately and print:
> "This directory is not a git repository. Initialize one with `git init` or navigate to your project root."

---

## Idempotency Check

Before beginning the wizard stages, check whether `.claude/taskflow-config.json` already exists.

**If the config file exists AND `--reconfigure` was NOT passed:**

1. Read and parse the existing config file.
2. Show a summary:
   > "Existing taskflow config found: provider=`<provider>`, workspace=`<workspace_name>`, `<N>` areas configured."
3. Ask ONE question:
   > "(a) Update specific settings  (b) Reconfigure from scratch  (c) Cancel"
4. Wait for the user's response.
   - **(a)** Ask which stage to re-run (list the stage names: Provider, Workspace, Lists, Identity, Areas, Extra Areas, Conventions). Run only that stage, merge the result into the existing config, and write the updated config.
   - **(b)** Proceed with the full wizard from Stage 1, overwriting the existing config.
   - **(c)** Stop. Print: "Setup cancelled."

**If `--reconfigure` was passed:** Proceed with the full wizard from Stage 1 regardless of whether a config file exists.

**If no config file exists:** Proceed with the full wizard from Stage 1.

---

## Stage 1: Provider Selection

Detect which provider MCP tools are available by checking for tool name prefixes.

**If only one provider is detected:**
Confirm with the user:
> "I detected ClickUp MCP tools. Using ClickUp as the provider. [Y/n]"

Wait for confirmation. If the user declines, stop and ask which provider they intended.

**If multiple providers are detected (future):**
Present lettered options and ask the user to choose:
> "I detected multiple project management tools:
> (a) ClickUp
> (b) Jira
> Which provider should taskflow use?"

Wait for the user's response.

**If no providers are detected:**
Stop and print:
> "No project management MCP server detected. Install the ClickUp MCP server and try again."

Store the selected provider (e.g., `"clickup"`).

---

## Stage 2: Workspace Selection

Fetch the workspace list from the provider.

1. Call `get_workspaces()` to retrieve available workspaces.
   - For ClickUp: call `clickup_get_workspace_hierarchy`

2. **If one workspace is found:**
   Confirm:
   > "I found one workspace: '<name>'. Is this correct? [Y/n]"
   Wait for confirmation.

3. **If multiple workspaces are found:**
   Present lettered options:
   > "I found multiple workspaces:
   > (a) <Workspace A name>
   > (b) <Workspace B name>
   > Which workspace should taskflow use?"
   Wait for the user's response.

4. **If no workspaces are found:**
   Stop and print:
   > "No workspaces found. Check your MCP server authentication and try again."

Store `workspace_id` and `workspace_name`.

---

## Stage 3: List Selection

Fetch the full hierarchy for the selected workspace and let the user choose which lists to pull tasks from.

1. Call `get_hierarchy(workspace_id)` to get spaces, folders, and lists.
   - For ClickUp: call `clickup_get_workspace_hierarchy` and drill into the selected workspace

2. Present lists grouped by space and folder for clarity. Format example:

   ```
   Space: Engineering
     Folder: Sprint Work
       (a) Sprint Backlog [id: 123456]
       (b) In Progress [id: 789012]
     Folder: Client
       (c) Client Tasks [id: 345678]

   Space: Design
     (d) Design Requests [id: 901234]
   ```

3. Ask:
   > "Which list(s) should taskflow pull tasks from? Enter letters separated by commas (e.g., a,c)."

   Wait for the user's response.

4. After the user selects one or more lists, ask:
   > "Which list should be the default? [<first selected list name>]"

   If only one list was selected, confirm it as the default without asking.

Store as a `lists` array in the provider config, with `"default": true` on the default list.

---

## Stage 4: Developer Identity

Identify the developer who will be using taskflow in this project.

1. **Check Claude memory for an existing identity** (name and provider user ID).

2. **If found:**
   Confirm:
   > "I have your identity saved: <name> (ID: <id>). Is this still correct? [Y/n]"
   Wait for confirmation. If confirmed, use the stored identity.

3. **If not found, or if the user says the stored identity is wrong:**
   Ask:
   > "What is your full name? (This is used to find your account in the project management tool.)"
   Wait for the response.

4. Look up the user in the provider:
   - For ClickUp: call `clickup_find_member_by_name` with the provided name

5. Confirm the match:
   > "Found: <name> (ID: <id>). Is this you? [Y/n]"
   Wait for confirmation.

6. If confirmed, save the identity to Claude memory for future use across sessions.

---

## Stage 5: Codebase Scanning

Automatically detect the project structure and propose classification areas. Run these detections silently (no user interaction until proposals are ready).

### Detection Steps

1. **Top-level directories** — Check for common project structure directories:
   - `apps/`, `packages/`, `src/`, `lib/`, `services/`, `modules/`
   - Within `apps/` and `packages/`, list each subdirectory as a candidate area

2. **Package manager** — Detect which package manager is in use:
   - `pnpm-workspace.yaml` -> pnpm workspaces
   - `package.json` with `"workspaces"` field -> npm/yarn workspaces
   - `turbo.json` -> Turborepo
   - `lerna.json` -> Lerna
   - Plain `package.json` -> single-package project

3. **Build, lint, and test scripts** — Read `package.json` (root and per-area) and `turbo.json` to discover:
   - `lint` commands (e.g., `pnpm turbo run lint --filter=<area>`)
   - `typecheck` / `check-types` commands
   - `test` commands
   - `build` commands (for shared packages that need building before implementation)
   - `install` command (pnpm install, npm install, yarn install)

4. **Base branch** — Detect from git:
   ```bash
   git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
   ```
   Fall back to checking if `dev` or `main` branch exists. Propose the detected branch.

### Area Proposals

For each detected app/package directory, propose an area. Present them ONE AT A TIME.

For each area, show:
> "Detected area: **<kebab-case-name>**
> - Path: `<relative/path>`
> - Description: <auto-generated description based on contents>
> - Lint: `<detected lint command or "none detected">`
> - Typecheck: `<detected typecheck command or "none detected">`
> - Test: `<detected test command or "none detected">`
> - Build: `<detected build command or "none — not a shared package">`
>
> Accept this area? [Y/n/edit]"

Wait for the user's response before presenting the next area.

- **Y (or Enter):** Accept the area as proposed.
- **n:** Skip this area — do not include it in the config.
- **edit:** Ask which field(s) to change, apply the changes, and confirm the updated area.

**Naming rules for areas:**
- Use kebab-case (lowercase, hyphens)
- Derive from the directory name (e.g., `apps/backend` -> `backend`, `packages/common` -> `common`)
- Keep names short and descriptive

---

## Stage 6: Extra Areas

After all code areas are confirmed, ask about non-code task categories:

> "Are there task categories that aren't code changes? Examples: email template changes in an external dashboard, manual data entry, third-party config changes.
>
> List any (comma-separated), or press Enter to skip."

Wait for the user's response.

- If the user enters names: store them in the `extra_areas` array as-is.
- If the user presses Enter / skips: set `extra_areas` to an empty array.

---

## Stage 7: Branch and Output Conventions

Propose defaults detected from the project and confirm each one. Ask ONE question at a time.

### 7a. Branch Prefixes

> "Branch prefix conventions:
> - Bug fixes: `fix/`
> - Features: `feat/`
> - Chores: `chore/`
> - Refactors: `refactor/`
>
> Accept these defaults? [Y/n]"

If the user wants changes, ask which prefix(es) to update.

### 7b. Base Branch

> "Base branch for new worktrees: `<detected-branch>`. Correct? [Y/n]"

If wrong, ask for the correct branch name.

### 7c. Output Directory

> "Output directory for triage plans and state files: `docs/plans/taskflow`. Accept? [Y/n]"

If the user wants a different path, ask for it.

### 7d. Install Command

> "Install command: `<detected-command>` (e.g., `pnpm install`). Correct? [Y/n]"

### 7e. Build Before Implement

If shared packages were detected that need building before other apps can run (e.g., a `common` or `shared` package with a build script):

> "These packages should be built before implementation begins:
> - `<command>` (e.g., `pnpm common:build`)
>
> Correct? [Y/n]"

If no shared packages detected, propose an empty array and skip this question.

### 7f. Full Lint and Typecheck

> "Full-repo lint command: `<detected>` (e.g., `pnpm turbo run lint`). Correct? [Y/n]"

> "Full-repo typecheck command: `<detected>` (e.g., `pnpm turbo run check-types`). Correct? [Y/n]"

If not detected, ask the user to provide or skip (set to `null`).

---

## Stage 8: Write Config and Gitignore

### 8a. Assemble the Config

Build the full config object from all collected data. Use the schema defined in the Config Schema Reference section below.

### 8b. Write the Config File

1. Create the `.claude/` directory if it does not exist:
   ```bash
   mkdir -p .claude
   ```

2. Write the assembled JSON to `.claude/taskflow-config.json` with 2-space indentation.

### 8c. Update .gitignore

Check if the output directory is already in `.gitignore`. If not, append it:

```bash
echo "" >> .gitignore
echo "# Taskflow triage output" >> .gitignore
echo "<output_dir>/" >> .gitignore
```

If `.gitignore` does not exist, create it with just the output directory entry.

### 8d. Print the Config

Print the full config JSON to the terminal so the user can review it.

### 8e. Final Message

Print:
> "Config written to `.claude/taskflow-config.json`. Review it and adjust any values if needed.
>
> Next steps:
> - Run `/taskflow:triage` to pull and classify your tasks
> - Run `/taskflow:implement` to execute a batch"

---

## Config Schema Reference

The setup wizard produces a config file matching this exact schema. All fields are required unless noted.

```json
{
  "version": 1,
  "provider": "clickup",
  "project_name": "<detected from repo directory name>",
  "<provider>": {
    "workspace_id": "<from stage 2>",
    "workspace_name": "<from stage 2>",
    "lists": [
      { "id": "<list id>", "name": "<list name>", "default": true },
      { "id": "<list id>", "name": "<list name>", "default": false }
    ]
  },
  "areas": {
    "<area-name>": {
      "description": "<short description of what this area covers>",
      "paths": ["<relative/path/to/area>"],
      "lint": "<lint command for this area, or null>",
      "typecheck": "<typecheck command for this area, or null>",
      "test": "<test command for this area, or null>",
      "build": "<build command for this area, or null>"
    }
  },
  "extra_areas": ["<non-code area name>"],
  "branch_conventions": {
    "bug": "fix/",
    "feature": "feat/",
    "chore": "chore/",
    "refactor": "refactor/"
  },
  "output_dir": "docs/plans/taskflow",
  "base_branch": "<branch name>",
  "build_before_implement": ["<build command for shared packages>"],
  "install_command": "<package install command>",
  "full_lint": "<full repo lint command or null>",
  "full_typecheck": "<full repo typecheck command or null>"
}
```

**Field notes:**

| Field | Description |
|-------|-------------|
| `version` | Always `1` for this schema version |
| `provider` | The project management tool identifier (e.g., `"clickup"`) |
| `project_name` | Derived from the git repo's root directory name |
| `<provider>` | Provider-specific config block. Key name matches the `provider` value |
| `areas` | Code areas detected in Stage 5. Keys are kebab-case area names. Each area may have `lint`, `typecheck`, `test`, and `build` commands (set to `null` if not applicable) |
| `extra_areas` | Non-code task categories from Stage 6. Empty array if none |
| `branch_conventions` | Maps task type to branch prefix |
| `output_dir` | Relative path where triage/implement writes state and plan files |
| `base_branch` | Branch to create worktrees and PRs against |
| `build_before_implement` | Commands to run in a fresh worktree before implementation. Empty array if none |
| `install_command` | Command to install dependencies (e.g., `"pnpm install"`) |
| `full_lint` | Command to lint the entire repo. `null` if not available |
| `full_typecheck` | Command to typecheck the entire repo. `null` if not available |

---

## Provider Appendix: ClickUp

Use this section when the selected provider is ClickUp.

### MCP Tool Mapping

| Operation | MCP Tool |
|-----------|----------|
| `get_workspaces()` | `clickup_get_workspace_hierarchy` |
| `get_hierarchy(workspace_id)` | `clickup_get_workspace_hierarchy` (drill into specific workspace) |
| `find_member(name)` | `clickup_find_member_by_name` |

### Workspace Hierarchy

ClickUp hierarchy: Workspace -> Space -> Folder -> List. Tasks live in Lists.

When presenting lists to the user in Stage 3, group by Space and Folder for clarity. Use indentation to show the hierarchy:

```
Space: <space name>
  Folder: <folder name>
    (a) <list name> [id: <list_id>]
    (b) <list name> [id: <list_id>]
  (c) <list name> [id: <list_id>]  (folderless list)
```

Lists that are not inside a folder should appear directly under the space, one indent level less than lists inside folders.

---

## Error Handling

**MCP tool failures:**
- If any MCP call fails during workspace or list retrieval, report the error and stop. Do not guess workspace or list IDs.
- If member lookup fails, ask the user to provide their ID manually.

**File write failures:**
- If writing `.claude/taskflow-config.json` fails (e.g., permissions), report the error and print the config JSON to the terminal so the user can save it manually.

**Incomplete wizard:**
- If the user cancels mid-wizard (e.g., Ctrl+C or explicit "cancel"), do not write a partial config file. Inform the user that setup was not completed.

---

## Interaction Rules

1. **Ask ONE question at a time.** Never present multiple questions or decisions in a single message.
2. **Wait for the user's response** before proceeding to the next question or stage.
3. **Use short confirmations** — default to [Y/n] where Y is the expected answer.
4. **Show progress** — before each stage, briefly state what you are doing (e.g., "Scanning codebase structure...").
5. **Be concise** — do not over-explain. The user is a developer; keep language technical and direct.
