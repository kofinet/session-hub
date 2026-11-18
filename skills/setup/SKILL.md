---
name: setup
description: Configure session-hub for the project this session works in - work out its CI/deploy/smoke workflows, production URLs, local docker stacks, busy containers, quick command checks and guards (main checkout, migration numbers) from the repository, its history and this session, propose them for confirmation, and save them to session-hub's settings outside the repository. Use when the person runs /session-hub:setup, asks to set up or change session-hub's band, checks, notifications or guards for a project, or session-hub says the project has no settings.
---

# Set up session-hub for this project

session-hub keeps one entry per project in its settings file, outside every repository
(`~/.claude/session-hub/settings.local.json`, or `$SESSION_HUB_SETTINGS`). You work the entry out,
the person confirms it, and the mod's tool writes it. Talk to the person in their language.

## 1. Facts

Load both tools in one call: ToolSearch `select:mcp__session-hub__project_detect,mcp__session-hub__project_save`.
Call `mcp__session-hub__project_detect`. It returns the main checkout, `origin`, the default branch,
the GitHub Actions workflows with their recent runs, the running docker containers grouped by compose
project (with ports), folders of numbered files, whether the repository uses worktrees, the settings
file's path and the entry it already holds for this project (`existingProject`). With an existing
entry, start from it and propose only changes.

## 2. Work out the checks (read-only)

Read just enough to decide; do not run builds, tests or containers.

- **Workflows** (`type: workflow`): open the YAML of each active workflow and read its `on:`.
  - Runs on push to the default branch and on PRs: `role: "ci"`, `event: "push"`, `onSessionBranch: true`.
  - Runs after CI (`workflow_run`) or deploys/publishes: `role: "deploy"`.
  - Scheduled checks of production (smoke, synthetic monitoring, uptime): `role: "check"`.
  - Skip workflows that only build images, label PRs or run by hand, unless the person cares about them.
- **Production** (`type: http`): public URLs of the deployed app. Find them in the deploy/smoke
  workflows (env, `vars.*` defaults), README, CLAUDE.md, docs, infrastructure config. Only public
  `https://` URLs that answer without credentials; never a URL carrying a token. One check per
  environment (`prod`, `staging`, …), each with its own `accounts` document (see below).
- **Local stacks** (`type: docker`): from `dockerGroups` and the compose files in the repository
  (`docker-compose*.yml`, `compose*.yaml`): one check per stack the person runs locally, its
  `containerPrefixes` (the compose project plus `-`, or the shared prefix of its container names) and,
  when it serves a page, its local `url` (`https://*.localhost`, `http://localhost:<port>`).
  Use this session's transcript too: the stacks and addresses the session started or used.
  - **Its accounts** (`accounts`, optional): see *Accounts documents* below. The pane shows a local
    instance's accounts only while it runs.
- **Accounts documents** (`accounts` on an `http` or `docker` check, optional): the repository's
  document of that environment's test accounts and test data (seeded admins, operators, test users,
  how to sign in, test cards), as a path relative to the repository root, one per environment:
  `docs/test_data_prod.md`, `docs/test_data_staging.md`, `docs/test_data_local.md`. The pane shows
  each in a folded group under the check's label. Look for existing ones first: docs or READMEs
  about test accounts, credentials or a cheat sheet (`test_data_*`, `*CREDENTIALS*`, `*ACCOUNTS*`,
  a "test accounts" section); keep the names the repository already uses. One document can serve
  several local stacks. When there is none, propose creating one per environment with that name:
  a Markdown table `| Role | Login | Password | Where |`, one row per account, filled from the seed
  scripts, compose environment, test helpers and this session.
  - Local: only the obviously fake logins those files already hold (`admin@example.local`,
    `admin / admin123`).
  - Production and staging: logins only; the Password cell says where the password is kept
    (`(1Password: Shop prod)`), never the password. Never a value from `.env` or a secret store.
  - They are files in the repository: write them only after the person confirmed them, with the rest
    of the proposal.
- **Busy containers** (`type: busy`): containers that tests or other sessions run and nobody should
  touch, e.g. parallel e2e lanes started by a script with a fixed name prefix.
- **Command checks** (`type: command`): only a quick, read-only command that says whether something
  is fine (exit 0) and that the person wants watched, e.g. a type check under a minute.
  `command` is an argument list (no shell), `everySeconds` at least 60 (default 300). Do not
  propose test suites or anything that writes.
- **Guards**:
  - `mainCheckout: true` when the repository works in worktrees (`usesWorktrees`, `.claude/worktrees`,
    or the project's CLAUDE.md or memory says each session works in its own worktree).
  - `migrationDirs`: the `numberedFileDirs` that hold database migrations (`.sql` and the like), as
    paths relative to the repository root. Not numbered docs or fixtures.

Labels are short and in the person's language (`CI`, `deploy`, `smoke`, `prod`, `dev`, `e2e`).
The band shows the checks in the order listed: CI, deploy, smoke, production, local stacks, busy.

## 3. Propose and confirm

Show the proposal as a short table: label, type, what it checks, where you found it. Then the guards,
then the JSON entry. Ask with AskUserQuestion whether to save it (options: save as proposed;
change something, where the person says what). Apply changes and ask again until they confirm.

The entry's shape:

```json
{
  "name": "my-app",
  "match": { "remote": "github.com/acme/my-app" },
  "branch": "main",
  "checks": [
    { "type": "workflow", "label": "CI", "workflow": "CI", "role": "ci", "event": "push", "onSessionBranch": true },
    { "type": "workflow", "label": "deploy", "workflow": "Deploy", "role": "deploy" },
    { "type": "workflow", "label": "smoke", "workflow": "Prod smoke", "role": "check" },
    { "type": "http", "label": "prod", "urls": ["https://my-app.example/"], "accounts": "docs/test_data_prod.md" },
    { "type": "docker", "label": "dev", "containerPrefixes": ["my-app-dev-"], "url": "https://app.localhost/", "accounts": "docs/test_data_local.md" },
    { "type": "busy", "label": "e2e", "containerPrefixes": ["my-app-e2e-"] },
    { "type": "command", "label": "types", "command": ["npx", "tsc", "--noEmit"], "everySeconds": 600 }
  ],
  "guards": { "mainCheckout": true, "migrationDirs": ["db/migrations"] }
}
```

`match.remote` is the `owner/repo` part of `origin` (it matches any URL form of it).

## 4. Save

Only after the person confirmed: call `mcp__session-hub__project_save` with `{ "project": <entry> }`
(add `"language": "en" | "pl"` only when the person asked to change the interface language; without
it the language stays as it is).
It validates the entry, replaces an entry of the same name and leaves the rest of the file as it was.
Never write the settings file with Write or Edit, and never put it in the repository. Tell the person
what was saved and that the band above the prompt shows the checks within a minute.
