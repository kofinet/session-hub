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

Then the **test data documents**: every environment the entry names (each `http` and `docker` check:
`prod`, `staging`, local stacks) gets one, in the format of [test-data-format.md](test-data-format.md) (read
it now; it is the only format session-hub's tabs are made for). This runs on the first install and again
every time the person runs `/session-hub:modinstal`, so a re-run brings the documents up to the format. For
each environment:

- **`docs/test_data_<label>.md` exists and follows the format**: point the check's `accounts` at it; propose
  only the rows step 2 found that it lacks.
- **It exists in another shape, or the check's `accounts` names another document** (a cheat sheet,
  `LOCAL_TEST_CREDENTIALS.md`): propose `docs/test_data_<label>.md` converted from it as the format's
  *Converting* section says (every account, bank account, company, card and URL a table row, nothing
  dropped), and point `accounts` at the new file. Ask whether the old document stays (with a pointer to the
  new one as its first line) or is removed; keep it when unsure.
- **There is none**: propose it, filled from what step 2 found, the environment's URLs from its check at
  least. A section with nothing in it is left out.

Show each proposed document whole, as it will be written.

When the project's `CLAUDE.md` does not say where its test data lives, propose one line for it, e.g.
`Test data per environment: docs/test_data_prod.md, docs/test_data_staging.md, docs/test_data_dev.md.`

## 4. Propose and confirm

Show, briefly: a table of the checks (label, type, what it checks, where you found it), the guards,
the test data documents (kept / converted / new, each new or rewritten one whole), the `CLAUDE.md` line, and the
JSON entry. Then ask with AskUserQuestion, in one call, two questions:

- whether to apply it (options: apply all; change something, where the person says what);
- the **interface language** of the mod: the pane, the band, the status line, notifications and the
  guards' messages (options: English (`en`); Polski (`pl`)). Put first, marked recommended, the
  language the person writes in when it is one of the two, else English. It applies to all projects.

Apply their changes and ask again until they confirm.

## 5. Apply

Only after the confirmation:

1. Write the test data documents (new and converted ones, the pointer in an old one that stays) and the
   `CLAUDE.md` line with Write/Edit (they belong in the repository; do not commit them unless the person
   asks).
2. Save the entry and the language with `mcp__session-hub__project_save`
   `{ "project": <entry>, "language": "en" | "pl" }`. Never write the settings file with Write or
   Edit, and never put it in the repository.

## 6. Reload

Ask the person to run `/reload-plugins` (or start a new session), so the plugin and its settings
are loaded fresh. Then say what to expect: the session hub opens by itself when a session starts, next
to it every environment's tab (`🧪 <label> test data`) with its document, whether the environment runs or
not, and the band above the prompt shows the checks within a minute.
