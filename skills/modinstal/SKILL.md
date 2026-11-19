---
name: modinstal
description: Configure session-hub from scratch for the project this session works in - check that the mod is loaded, gather what the project's memory, CLAUDE.md, docs and code already say (CI and deploy workflows, production and staging URLs, local docker stacks, worktrees, migrations, test accounts), propose the band's checks, the guards and the test data documents (docs/test_data_<environment>.md), save what the person confirms, and ask them to reload the plugin. Use when the person runs /modinstal or /session-hub:modinstal, or asks to install or set up session-hub (the mod) for a new project.
---

# Install session-hub for this project

You set up everything session-hub needs for the project this session works in, in one pass, filling in
as much as you can yourself and asking the person only to confirm or correct. Talk to them in their
language. Nothing is written until they confirm.

## 1. The mod is loaded

Load the mod's tools in one call: ToolSearch `select:mcp__session-hub__project_detect,mcp__session-hub__project_save`.

If they are not there, the plugin is not installed or not loaded in this session. Say so and give the
two ways out, then stop:

- not installed: `/plugin install session-hub --marketplace kofinet/session-hub` (user scope), then `/reload-plugins`;
- installed but not loaded (e.g. installed during this session): `/reload-plugins`.

## 2. What the project already says

Call `mcp__session-hub__project_detect` for the repository's facts (main checkout, `origin`, default
branch, workflows with their runs, running containers by compose project, numbered folders, worktrees,
the settings file and the project's existing entry). Then read, without running anything:

- **The project's memory**: Claude's memory folder for this project,
  `~/.claude/projects/<slug>/memory/` (Windows: `%USERPROFILE%\.claude\projects\<slug>\memory\`),
  where `<slug>` is the main checkout's absolute path with every `:`, `\`, `/` and `.` replaced by `-`
  (`C:\Users\me\Projects\shop` → `C--Users-me-Projects-shop`). Read its `MEMORY.md` and the entries that
  are about environments, URLs, deploys, test accounts, worktrees or migrations. A worktree of the
  project has its own folder next to it; read those too when they exist.
- **Instructions**: the repository's `CLAUDE.md` files (root and nested), `.claude/settings.json`,
  `AGENTS.md`.
- **Docs and code**: README, `docs/`, the workflows' YAML, compose files, seed scripts, test helpers,
  `.env.example` (names only, never values from `.env`).
- **This session**: what it started, the addresses and logins it gave.

What memory or docs say wins over a guess from code; when they disagree with the code, say so in the
proposal.

## 3. Work out the entry

Follow sections 2 and 3 of the `session-hub:setup` skill (load it with the Skill tool): the checks
(workflows with their roles, `http` per environment, `docker` stacks, `busy` containers, quick
`command` checks), the guards (`mainCheckout`, `migrationDirs`) and the entry's shape. With an existing
entry, start from it and propose only changes.

Then the **test data documents**, one per environment the entry names (`prod`, `staging`, local stacks):
`docs/test_data_<environment>.md` unless the repository already keeps such a document under another
name (then reuse it). For each:

- it exists: point the check's `accounts` at it;
- it does not: propose it, filled from what step 2 found, in these `## ` sections (the environment's
  tab shows the accounts as one table and every other section under its heading), leaving out a
  section with nothing in it:

  ```markdown
  # Test data: <environment>
  
  ## Accounts
  | Role | Login | Password | Where |
  |---|---|---|---|
  | Tenant admin | admin@shop.example | (1Password: Shop prod) | /admin |
  
  ## URLs
  - App: https://shop.example/
  
  ## Payments
  - Stripe test card OK: 4242 4242 4242 4242
  
  ## Notes
  - How to sign in, what not to touch.
  ```

  Production and staging: logins only, the Password cell says where the
  password is kept (`(1Password: Shop prod)`), never the password itself. Local: only the obviously
  fake seeded logins the repository already holds. Never a value from `.env` or a secret store.

When the project's `CLAUDE.md` does not say where its test data lives, propose one line for it, e.g.
`Test data per environment: docs/test_data_prod.md, docs/test_data_staging.md, docs/test_data_local.md.`

## 4. Propose and confirm

Show, briefly: a table of the checks (label, type, what it checks, where you found it), the guards,
the test data documents (existing / new, with the new ones' content), the `CLAUDE.md` line, and the
JSON entry. Then ask with AskUserQuestion, in one call, two questions:

- whether to apply it (options: apply all; change something, where the person says what);
- the **interface language** of the mod: the pane, the band, the status line, notifications and the
  guards' messages (options: English (`en`); Polski (`pl`)). Put first, marked recommended, the
  language the person writes in when it is one of the two, else English. It applies to all projects.

Apply their changes and ask again until they confirm.

## 5. Apply

Only after the confirmation:

1. Write the new test data documents and the `CLAUDE.md` line with Write/Edit (they belong in the
   repository; do not commit them unless the person asks).
2. Save the entry and the language with `mcp__session-hub__project_save`
   `{ "project": <entry>, "language": "en" | "pl" }`. Never write the settings file with Write or
   Edit, and never put it in the repository.

## 6. Reload

Ask the person to run `/reload-plugins` (or start a new session), so the plugin and its settings
are loaded fresh. Then say what to expect: the band above the prompt shows the checks within a minute,
`/hub` opens the session's pane, and its **Accounts** section (**Konta** in Polish) lists the test
data documents under their environments.
