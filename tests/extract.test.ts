import { expect, test } from 'claude-code/testing'

import {
  docAccounts,
  extract,
  findAccounts,
  findLoginEmails,
  listeningPorts,
  localUrls,
  parseWorktrees,
  sessionOnlyAccounts,
  summarizeChecks,
  worktreeAddPaths,
} from '../hooks/extract'
import type { Msg } from '../hooks/extract'

const messages: Msg[] = [
  {
    role: 'assistant',
    text: 'Aplikacja działa na http://localhost:8080 — zaloguj się jako **admin / admin123**.',
    toolUses: [
      {
        tool: 'Bash',
        input: { command: 'npm run dev -- --port 5173', run_in_background: true },
        text: 'Command running in background with ID: bk1. Output is being written to: C:\\tmp\\tasks\\bk1.output',
      },
      {
        tool: 'Bash',
        input: { command: 'docker run --rm -p 5174:5174 -p 8025:8025 shop-test', run_in_background: true },
        text: 'Command running in background with ID: bk2. Output is being written to: C:\\tmp\\tasks\\bk2.output',
      },
      { tool: 'Bash', input: { command: 'git commit -m "x" && gh pr create --fill' }, text: 'https://github.com/acme/shop/pull/42' },
      { tool: 'Bash', input: { command: 'gh pr merge 7 --squash' }, text: 'Merged' },
      { tool: 'Bash', input: { command: 'git worktree add -b feat/x ../repo-x origin/main' }, text: 'Preparing worktree' },
      { tool: 'Write', input: { file_path: 'C:\\repo\\docs\\overview.md', content: '# Overview' }, text: 'ok' },
      { tool: 'Write', input: { file_path: 'C:\\repo\\CLAUDE.md', content: '' }, text: 'ok' },
      {
        tool: 'Artifact',
        input: { file_path: 'C:\\tmp\\scratch\\arch-diagram.html' },
        text: 'Published https://claude.ai/code/artifact/abc-123 (private)',
      },
      { tool: 'Write', input: { file_path: 'C:\\tmp\\scratch\\arch-diagram.html', content: '' }, text: 'ok' },
    ],
  },
  {
    role: 'user',
    text: '<task-notification>\n<task-id>bk2</task-id>\n<status>completed</status>\n</task-notification>',
    toolUses: [],
  },
  {
    role: 'assistant',
    text: '| user | password |\n|---|---|\n| jan@test.pl | Secret1! |\n\nusername: tester\npassword: tester123\nPanel: https://app.localhost — zaloguj się jako admin@shop.local',
    toolUses: [],
  },
]

test("collects only what this session did and said", async () => {
  const found = extract(messages)

  expect(found.processes.map(p => [p.id, p.status])).toEqual([
    ['bk1', 'running'],
    ['bk2', 'completed'],
  ])
  expect(found.processes[0]?.outputFile).toBe('C:\\tmp\\tasks\\bk1.output')
  expect(found.processes[0]?.urls.map(u => u.url)).toEqual(['http://localhost:5173'])
  expect(found.processes[1]?.urls.map(u => u.port)).toEqual([5174, 8025])
  expect(found.urls.map(u => u.url)).toEqual(['http://localhost:8080', 'https://app.localhost'])
  expect(found.accounts).toEqual([
    { user: 'admin', password: 'admin123' },
    { user: 'jan@test.pl', password: 'Secret1!' },
    { user: 'tester', password: 'tester123' },
    { user: 'admin@shop.local' },
  ])
  expect(found.prs).toEqual([
    { ref: 'https://github.com/acme/shop/pull/42', url: 'https://github.com/acme/shop/pull/42', repo: 'acme/shop', number: 42 },
    { ref: '7', number: 7 },
  ])
  expect(found.worktreePaths).toEqual(['../repo-x'])
  expect(found.artifacts.map(a => a.label)).toEqual(['overview.md', 'arch-diagram'])
  expect(found.artifacts[0]?.href).toBe('file:///C:/repo/docs/overview.md')
})

test('ignores what the session only read: files, PR lists, curl targets, subagent prose', async () => {
  const read: Msg[] = [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool: 'Read', input: { file_path: 'C:\\repo\\docs\\CREDENTIALS.md' }, text: 'admin / admin123 at http://localhost:9999' },
        { tool: 'Bash', input: { command: 'gh pr list' }, text: 'https://github.com/acme/shop/pull/1' },
        { tool: 'Bash', input: { command: 'cat docs/LOCAL.md' }, text: 'username: x1\npassword: y123' },
        { tool: 'Bash', input: { command: 'curl -s http://localhost:3003/health' }, text: 'Healthy' },
      ],
    },
  ]
  const agent: Msg[] = [
    {
      role: 'assistant',
      text: 'Zaloguj się jako boss / boss123 na http://localhost:7777',
      toolUses: [{ tool: 'Bash', input: { command: 'gh pr create --fill' }, text: 'https://github.com/acme/shop/pull/50' }],
    },
  ]
  const found = extract(read, agent)
  expect(found.processes).toEqual([])
  expect(found.urls).toEqual([])
  expect(found.accounts).toEqual([])
  expect(found.prs.map(p => p.number)).toEqual([50])
})

test('lists only the artifacts the session published, not the ones it listed, read or picked a type from', async () => {
  const found = extract([
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool: 'Artifact',
          input: { action: 'list', scope: 'all', limit: 60 },
          text: 'Notes https://claude.ai/artifact/listed1\nBudget https://claude.ai/artifact/listed2',
        },
        { tool: 'Artifact', input: { action: 'quickstart', intent: 'other' }, text: 'Slides https://claude.ai/artifact/type1' },
        { tool: 'Artifact', input: { action: 'read', url: 'https://claude.ai/artifact/read1' }, text: 'https://claude.ai/artifact/read1' },
        {
          tool: 'Artifact',
          input: { action: 'publish', type_url: 'https://claude.ai/artifact/type1', title: 'Brand kit' },
          text: 'Created https://claude.ai/artifact/new1 from https://claude.ai/artifact/type1',
        },
        {
          tool: 'Artifact',
          input: { action: 'publish', url: 'https://claude.ai/artifact/edited1', root: 'C:/s/canvas' },
          text: 'Updated https://claude.ai/artifact/edited1 with design system https://claude.ai/artifact/ds1',
        },
        { tool: 'Artifact', input: { file_path: 'C:/s/report.html' }, text: 'Published https://claude.ai/artifact/new2' },
      ],
    },
  ])
  expect(found.artifacts.map(a => [a.label, a.href])).toEqual([
    ['Brand kit', 'https://claude.ai/artifact/new1'],
    ['Artifact', 'https://claude.ai/artifact/edited1'],
    ['report', 'https://claude.ai/artifact/new2'],
  ])
})

test('marks a stopped task and a failed start', async () => {
  const found = extract([
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool: 'Bash', input: { command: 'vite', run_in_background: true }, text: 'Command running in background with ID: a1.' },
        { tool: 'TaskStop', input: { task_id: 'a1' }, text: 'Stopped a1' },
        { tool: 'Bash', input: { command: 'dotnet run', run_in_background: true }, text: 'permission denied' },
      ],
    },
  ])
  expect(found.processes.map(p => p.status)).toEqual(['killed', 'failed'])
})

test('lists a range shortcut one account at a time, each with what the session said about it', async () => {
  const found = extract([
    {
      role: 'assistant',
      text: [
        'Konta demo: `klient1..3@example.com`.',
        '- `klient1@example.com`: Anna Kowalska, osoba prywatna.',
        '- `klient2@example.com` (firma, NIP 1234567890)',
        '| Admin sklepu | `admin@shop.local` | panel admina (app.) |',
        'Napisz na biuro@firma.pl albo sprawdź klient1..30@example.com.',
      ].join('\n'),
      toolUses: [],
    },
  ])
  expect(found.accounts).toEqual([
    { user: 'klient1@example.com', note: 'Anna Kowalska, osoba prywatna.' },
    { user: 'klient2@example.com', note: 'firma, NIP 1234567890' },
    { user: 'klient3@example.com' },
    { user: 'admin@shop.local', note: 'Admin sklepu · panel admina (app.)' },
  ])
})

test("a local instance's accounts doc: every login once, with the row it stands in", async () => {
  const doc = [
    '# Local accounts',
    '',
    '| Role | Login | Where |',
    '|---|---|---|',
    '| **Tenant admin** | `admin@shop.local` | admin app |',
    '| **Operator** | `operator@example.com` | operator panel (/admin) |',
    '',
    'Log in as `admin@shop.local` and open the orders.',
    'Seeded customers: `klient1@example.com` and `klient2@example.com`.',
  ].join('\n')
  expect(docAccounts(doc)).toEqual([
    { user: 'admin@shop.local', note: 'Tenant admin · admin app' },
    { user: 'operator@example.com', note: 'Operator · operator panel (/admin)' },
    { user: 'klient1@example.com' },
    { user: 'klient2@example.com' },
  ])
  expect(docAccounts('nothing to log in with here')).toEqual([])
})

test("a local instance's accounts doc in the setup's table: every row keeps its role and place, in the document's order", async () => {
  const doc = [
    '| Role | Login | Password | Where |',
    '|---|---|---|---|',
    '| Operator | admin | admin123 | /admin |',
    '| Customer | `klient@shop.local` | | shop |',
    '| Support | support | support1 | /help |',
  ].join('\n')
  expect(docAccounts(doc)).toEqual([
    { user: 'admin', password: 'admin123', note: 'Operator · /admin' },
    { user: 'klient@shop.local', note: 'Customer · shop' },
    { user: 'support', password: 'support1', note: 'Support · /help' },
  ])
})

test("a local instance's accounts doc: the same address in other capitals is one account", async () => {
  const doc = ['| Role | Login | Where |', '|---|---|---|', '| Admin | `Admin@shop.local` | admin app |', '', 'Log in as `admin@shop.local`.'].join('\n')
  expect(docAccounts(doc)).toEqual([{ user: 'Admin@shop.local', note: 'Admin · admin app' }])
})

test("a local instance's accounts doc: a login whose password cell is empty or a placeholder is still listed, without a password", async () => {
  const doc = [
    '| Role | Login | Password | Where |',
    '|---|---|---|---|',
    '| Viewer | viewer | | /reports |',
    '| Admin | admin | (in .env) | /admin |',
  ].join('\n')
  expect(docAccounts(doc)).toEqual([
    { user: 'viewer', note: 'Viewer · /reports' },
    { user: 'admin', note: 'Admin · /admin' },
  ])
})

test("a local instance's accounts doc: a short login is placed where it is listed, not where its letters first appear", async () => {
  const doc = [
    'Seeded: admin@shop.local, klient@example.com',
    '',
    '| Role | Login | Password |',
    '|---|---|---|',
    '| Operator | operator | op1 |',
    '| Admin | admin | admin123 |',
  ].join('\n')
  expect(docAccounts(doc).map(a => a.user)).toEqual(['admin@shop.local', 'klient@example.com', 'operator', 'admin'])
})

test("the session's accounts: one a running instance's doc lists is left out, the same login with another password stays", async () => {
  const listed = [{ user: 'admin', password: 'admin123' }, { user: 'Ops@shop.local' }]
  const session = [
    { user: 'admin', password: 'NewPass1' },
    { user: 'admin', password: 'admin123' },
    { user: 'ops@shop.local' },
    { user: 'dev@shop.local', note: 'seeded by this session' },
  ]
  expect(sessionOnlyAccounts(session, listed)).toEqual([
    { user: 'admin', password: 'NewPass1' },
    { user: 'dev@shop.local', note: 'seeded by this session' },
  ])
})

test('helpers', async () => {
  expect(findAccounts('password: process.env.DB_PASSWORD\nuser: <your-user>')).toEqual([])
  expect(findAccounts('Edit the user / password fields')).toEqual([])
  expect(findLoginEmails('Co-Authored-By: Claude <noreply@anthropic.com>\nlogin: ola@test.pl')).toEqual([{ user: 'ola@test.pl' }])
  expect(localUrls('http://0.0.0.0:5173/ and https://signup-acme.localhost/x.').map(u => u.url)).toEqual([
    'http://localhost:5173',
    'https://signup-acme.localhost',
  ])
  expect(worktreeAddPaths('git worktree add "C:/w t/x" -b y')).toEqual(['C:/w t/x'])
})

test('parses netstat, checks and worktrees', async () => {
  const win = '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING\n  TCP    127.0.0.1:5000  1.2.3.4:443  ESTABLISHED'
  expect([...listeningPorts(win)]).toEqual([8080])
  expect([...listeningPorts('tcp4  0  0  *.3000  *.*  LISTEN')]).toEqual([3000])
  expect(summarizeChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }])).toEqual({
    pass: 1,
    fail: 1,
    pending: 1,
  })
  expect(
    parseWorktrees('worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo-wt\nHEAD def\nbranch refs/heads/feat/x\n'),
  ).toEqual([
    { path: 'C:/repo', branch: 'main' },
    { path: 'C:/repo-wt', branch: 'feat/x' },
  ])
})
