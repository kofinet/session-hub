import { expect, test } from 'claude-code/testing'

import { extract, fileHref, findAccounts, findLoginEmails, listeningPorts, localUrls, parseWorktrees, summarizeChecks, worktreeAddPaths } from '../hooks/extract'
import type { Msg } from '../hooks/extract'

// What each detector of the session's transcript finds and what it leaves out.

type ToolUse = Msg['toolUses'][number]

const did = (...toolUses: ToolUse[]): Msg[] => [{ role: 'assistant', text: '', toolUses }]
const bash = (command: string, text = 'ok', background = false): ToolUse => ({
  tool: 'Bash',
  input: background ? { command, run_in_background: true } : { command },
  text,
})

test('local addresses: localhost, its subdomains and loopback, each origin once, nothing that only looks like one', async () => {
  const urls = (text: string) => localUrls(text).map(u => [u.url, u.port])
  expect(urls('see http://localhost:3000/path and http://localhost:3000.')).toEqual([['http://localhost:3000', 3000]])
  expect(urls('HTTPS://App.LocalHost:8443/x')).toEqual([['https://app.localhost:8443', 8443]])
  expect(urls('(http://127.0.0.1:5000)')).toEqual([['http://127.0.0.1:5000', 5000]])
  expect(urls('http://[::1]:8080/')).toEqual([['http://localhost:8080', 8080]])
  expect(urls('https://localhost and http://localhost, ok')).toEqual([
    ['https://localhost', 443],
    ['http://localhost', 80],
  ])
  expect(urls('http://a.b.localhost:5173 http://my_app.localhost')).toEqual([
    ['http://a.b.localhost:5173', 5173],
    ['http://my_app.localhost', 80],
  ])
  expect(urls('"http://localhost:4200"')).toEqual([['http://localhost:4200', 4200]])
  expect(urls('http://localhostfoo.com http://localhost:3000abc xhttp://localhost:3000 http://localhost:123456 http://localhost:1')).toEqual([])
  expect(urls('https://example.com:8080 ftp://localhost:21')).toEqual([])
})

test('ports a started command names: --port, PORT=, server.port=, -p', async () => {
  const ports = (command: string) =>
    extract(did(bash(command, 'Command running in background with ID: b1.', true))).processes[0]?.urls.map(u => u.port)
  expect(ports('vite --port=4000')).toEqual([4000])
  expect(ports('vite --port 4001')).toEqual([4001])
  expect(ports('PORT=3001 node app.js')).toEqual([3001])
  expect(ports('java -Dserver.port=8081 -jar app.jar')).toEqual([8081])
  expect(ports('docker run -p 8080:80 -p 9090:90 img')).toEqual([8080, 9090])
  expect(ports('APP_PORT=3000 node app.js')).toEqual([])
  expect(ports('node app.js --port=1')).toEqual([])
  expect(ports('npm run dev -- --port 5173 # http://localhost:5173')).toEqual([5173])
})

test('commands that leave something running count as started; builds, tests and stops do not', async () => {
  const starts = [
    'docker run --rm img',
    'docker compose -f dev.yml up -d',
    'docker-compose up',
    'DOCKER COMPOSE UP',
    './start-dev.ps1',
    'bash scripts/start.sh',
    'npm run dev',
    'npm start',
    'npm run preview',
    'npm serve',
    'npx vite',
    'vite',
    'vite build',
    'dotnet run --project Api',
    'dotnet watch',
    'python -m http.server 8000',
    'uvicorn app:app',
    'node server.js',
    'node dist/myserver.js',
  ]
  const others = ['docker compose down', 'docker compose -f x.yml upgrade', 'npm test', 'npm run build', 'dotnet build', 'vitest', 'git status', 'node app.js', 'restart.sh']
  for (const c of starts) expect([c, extract(did(bash(c))).processes.map(p => p.status)]).toEqual([c, ['started']])
  for (const c of others) expect([c, extract(did(bash(c))).processes]).toEqual([c, []])
})

test('a background task: its id, its output file, and the status its notifications give it', async () => {
  const found = extract([
    {
      role: 'assistant',
      text: '',
      toolUses: [
        bash('a', 'Command running in background with ID: b-1_x. Output is being written to: C:\\t\\b-1_x.output.', true),
        bash('b', 'Command running in background with ID: b2', true),
        bash('c', 'Command running in background with ID: b3', true),
        bash('d', 'Command running in background with ID: b4', true),
        bash('e', 'Command running in background with ID: b5', true),
      ],
    },
    {
      role: 'user',
      text: [
        '<task-notification>\n<task-id>b-1_x</task-id>\n<summary>x</summary>\n<status>exited</status>\n</task-notification>',
        '<task-notification><task-id>b2</task-id><status>Failed</status></task-notification>',
        '<task-notification><task-id>b3</task-id><status>cancelled</status></task-notification>',
        '<task-notification><task-id>b4</task-id><status>error</status></task-notification>',
        '<task-notification><task-id>b5</task-id><status>pending</status></task-notification>',
      ].join('\n'),
      toolUses: [],
    },
  ])
  expect(found.processes.map(p => [p.id, p.status, p.outputFile])).toEqual([
    ['b-1_x', 'completed', 'C:\\t\\b-1_x.output'],
    ['b2', 'failed', undefined],
    ['b3', 'killed', undefined],
    ['b4', 'failed', undefined],
    ['b5', 'running', undefined],
  ])
})

test('a task stop that failed leaves the task running', async () => {
  const found = extract(
    did(bash('vite', 'Command running in background with ID: a1.', true), { tool: 'KillShell', input: { shell_id: 'a1' }, text: 'Error: not found' }),
  )
  expect(found.processes.map(p => p.status)).toEqual(['running'])
})

test('PRs the session created or changed: their URLs and the numbers it named', async () => {
  const found = extract(
    did(
      bash('gh pr create --fill', 'https://github.com/a.b/c-d/pull/77\n'),
      bash('gh  pr   merge #12 --squash', 'Merged'),
      bash('gh pr comment 5 --body x', 'https://github.com/a.b/c-d/pull/5#issuecomment-1'),
      bash('gh pr edit 77 --title y', 'https://github.com/a.b/c-d/pull/77'),
      bash('gh pr view 3', 'https://github.com/a.b/c-d/pull/3'),
      bash('gh pr checkout 4', 'Switched'),
      { tool: 'Bash', input: { command: 'gh pr ready 8' } },
    ),
  )
  expect(found.prs).toEqual([
    { ref: 'https://github.com/a.b/c-d/pull/77', url: 'https://github.com/a.b/c-d/pull/77', repo: 'a.b/c-d', number: 77 },
    { ref: '12', number: 12 },
    { ref: 'https://github.com/a.b/c-d/pull/5', url: 'https://github.com/a.b/c-d/pull/5', repo: 'a.b/c-d', number: 5 },
  ])
})

test('design links the session gave or a tool returned, labelled by their host', async () => {
  const found = extract([
    {
      role: 'assistant',
      text: [
        'Projekt: https://www.figma.com/design/abc/Name?node-id=1-2) i https://canva.com/design/DAF1/view',
        'https://excalidraw.com/#json=abc,def https://excalidraw.com/ https://figma.com/community/x',
        'https://docs.google.com/document/d/1x/edit https://miro.com/app/board/uX=/',
        'https://gamma.app/docs/deck-1 "https://my-app.netlify.app/path?x=1" https://shop.vercel.app',
        'https://a.b.vercel.app http://figma.com/file/x https://sub.figma.com/design/x',
      ].join('\n'),
      toolUses: [{ tool: 'Bash', input: { command: 'deploy' }, text: 'Live: https://www.figma.com/proto/p1' }],
    },
  ])
  expect(found.artifacts.map(a => [a.label, a.href])).toEqual([
    ['figma.com', 'https://www.figma.com/design/abc/Name?node-id=1-2'],
    ['canva.com', 'https://canva.com/design/DAF1/view'],
    ['excalidraw.com', 'https://excalidraw.com/#json=abc,def'],
    ['docs.google.com', 'https://docs.google.com/document/d/1x/edit'],
    ['miro.com', 'https://miro.com/app/board/uX=/'],
    ['gamma.app', 'https://gamma.app/docs/deck-1'],
    ['my-app.netlify.app', 'https://my-app.netlify.app/path?x=1'],
    ['shop.vercel.app', 'https://shop.vercel.app'],
    ['figma.com', 'https://www.figma.com/proto/p1'],
  ])
})

test('documents the session wrote count as artifacts; code, config and Claude files do not', async () => {
  const write = (file_path: string): ToolUse => ({ tool: 'Write', input: { file_path, content: '' }, text: 'ok' })
  const docs = ['a.md', 'b.MDX', 'c.html', 'd.htm', 'e.pdf', 'f.docx', 'g.doc', 'h.pptx', 'i.xlsx', 'j.svg', 'k.png', 'l.drawio', 'm.excalidraw', 'n.mmd', 'o.puml']
  const others = [
    '/w/p.ts',
    '/w/q.json',
    '/w/r.xls',
    'C:\\repo\\.claude\\notes.md',
    '/home/u/repo/.claude/plan.md',
    '/repo/node_modules/x/README.md',
    'CLAUDE.md',
    'C:\\repo\\claude.md',
    '/repo/MEMORY.md',
    '/repo/AGENTS.md',
  ]
  const found = extract(did(...docs.map(d => write(`/w/${d}`)), ...others.map(write), write('/repo/MYCLAUDE.md')))
  expect(found.artifacts.map(a => a.label)).toEqual([...docs, 'MYCLAUDE.md'])
  expect(fileHref('C:\\a b\\c.md')).toBe('file:///C:/a%20b/c.md')
  expect(fileHref('/home/x.md')).toBe('file:///home/x.md')
})

test('artifacts: both claude.ai link forms, the label from the title, the page, or the kind and id', async () => {
  const found = extract(
    did(
      { tool: 'Artifact', input: {}, text: 'https://claude.ai/code/artifact/abc-123 and https://claude.ai/artifact/XYZ_9' },
      { tool: 'mcp__claude_ai_Claude_Docs__batch', input: {}, text: 'Doc: https://claude.ai/artifact/doc1.' },
      { tool: 'Artifact', input: { file_path: 'C:\\s\\plan.v2.html' }, text: 'https://claude.ai/artifact/p2' },
    ),
  )
  expect(found.artifacts.map(a => [a.label, a.href, a.kind])).toEqual([
    ['Artifact abc-123', 'https://claude.ai/code/artifact/abc-123', 'artifact'],
    ['Artifact XYZ_9', 'https://claude.ai/artifact/XYZ_9', 'artifact'],
    ['Claude Doc doc1', 'https://claude.ai/artifact/doc1', 'doc'],
    ['plan.v2', 'https://claude.ai/artifact/p2', 'artifact'],
  ])
})

test('artifact links a command printed or a read returned are not the session\'s artifacts', async () => {
  const found = extract(
    did(
      bash('python read_other_transcript.py', 'publish https://claude.ai/artifact/KTgp1fEhDtBvfUAVAM7c7Y\nlist https://claude.ai/code/artifact/abc-1'),
      { tool: 'Read', input: { file_path: 'C:/repo/tests/pane.test.ts' }, text: "text: 'https://claude.ai/code/artifact/abc'" },
      { tool: 'mcp__claude_ai_Claude_Docs__read', input: {}, text: 'Doc https://claude.ai/artifact/doc9' },
      { tool: 'mcp__claude_ai_Claude_Docs__query', input: {}, text: 'https://claude.ai/artifact/doc8' },
    ),
  )
  expect(found.artifacts).toEqual([])
})

test('an artifact without a title of its own is named by its earlier title, its page, or its id', async () => {
  const found = extract(
    did(
      { tool: 'Artifact', input: { action: 'publish', type_url: 'https://claude.ai/artifact/type1', title: 'COFFEE.NET' }, text: 'Created https://claude.ai/artifact/RpiKA4PJ' },
      { tool: 'Artifact', input: { action: 'publish', url: 'https://claude.ai/artifact/RpiKA4PJ', file_path: 'C:/s/ds/project/design-system.json' }, text: 'Updated' },
      { tool: 'Artifact', input: { action: 'publish', url: 'https://claude.ai/artifact/KTgp1fEhDtBvfUAVAM7c7Y', file_path: 'C:/s/canvas/project/canvas.json' }, text: 'Updated' },
      { tool: 'Artifact', input: { action: 'publish', file_path: 'C:/s/release-notes.md' }, text: 'Published https://claude.ai/artifact/notes1' },
      { tool: 'mcp__claude_ai_Claude_Docs__batch', input: {}, text: 'Created https://claude.ai/artifact/Doc12345xyz' },
    ),
  )
  expect(found.artifacts.map(a => [a.label, a.href])).toEqual([
    ['COFFEE.NET', 'https://claude.ai/artifact/RpiKA4PJ'],
    ['Artifact KTgp1fEh', 'https://claude.ai/artifact/KTgp1fEhDtBvfUAVAM7c7Y'],
    ['release-notes', 'https://claude.ai/artifact/notes1'],
    ['Claude Doc Doc12345', 'https://claude.ai/artifact/Doc12345xyz'],
  ])
})

test('worktrees the session entered, from the paths EnterWorktree printed', async () => {
  const found = extract(
    did(
      { tool: 'EnterWorktree', input: {}, text: 'Created worktree at C:\\repo\\.claude\\worktrees\\x on branch y (cwd C:\\repo)' },
      { tool: 'EnterWorktree', input: {}, text: 'Switched to /home/u/repo/.claude/worktrees/feat-x.' },
      { tool: 'EnterWorktree', input: {}, text: 'Now in "D:/w/Worktree-A".' },
    ),
  )
  expect(found.worktreePaths).toEqual(['C:\\repo\\.claude\\worktrees\\x', '/home/u/repo/.claude/worktrees/feat-x', 'D:/w/Worktree-A'])
})

test('worktrees the session added: every git worktree add, its path as typed', async () => {
  expect(worktreeAddPaths('git worktree add -b feat ../wt origin/main')).toEqual(['../wt'])
  expect(worktreeAddPaths('git worktree add --reason x -f ../wt')).toEqual(['../wt'])
  expect(worktreeAddPaths("git  worktree   add -B y '../x y' && git worktree add ../b; git worktree list")).toEqual(['../x y', '../b'])
  expect(worktreeAddPaths('git worktree add -b only')).toEqual([])
  expect(worktreeAddPaths('git worktree list')).toEqual([])
})

test('logins given as key and value: user, login, e-mail, użytkownik with a password on the same or the next two lines', async () => {
  expect(findAccounts('username: jan\npassword: Tajne123')).toEqual([{ user: 'jan', password: 'Tajne123' }])
  expect(findAccounts('login = "ola"\n\nhasło="xyz123"')).toEqual([{ user: 'ola', password: 'xyz123' }])
  expect(findAccounts('E-mail: a@b.pl, pwd: abc')).toEqual([{ user: 'a@b.pl', password: 'abc' }])
  expect(findAccounts("użytkownik: 'adam'\nhaslo: qwe123;")).toEqual([{ user: 'adam', password: 'qwe123' }])
  expect(findAccounts('USER: **bob** PASSWORD: `bob12345`.')).toEqual([{ user: 'bob', password: 'bob12345' }])
  expect(findAccounts('"email": "x@y.pl",\n"passwd": "Abc_123"')).toEqual([{ user: 'x@y.pl', password: 'Abc_123' }])
  expect(findAccounts('user: jan\n\n\npassword: late1')).toEqual([])
  expect(findAccounts('superuser: root\npassword: toor1')).toEqual([])
  expect(findAccounts('user: jan|pass: x1y2')).toEqual([{ user: 'jan', password: 'x1y2' }])
})

test('logins given as user / password on a line about logging in', async () => {
  expect(findAccounts('Zaloguj się: admin / admin123')).toEqual([{ user: 'admin', password: 'admin123' }])
  expect(findAccounts('Login: jan@x.pl / Haslo1!')).toEqual([{ user: 'jan@x.pl', password: 'Haslo1!' }])
  expect(findAccounts('Konto testowe — **tester / tester1**.')).toEqual([{ user: 'tester', password: 'tester1' }])
  expect(findAccounts('Sign-in as ops / opspass')).toEqual([{ user: 'ops', password: 'opspass' }])
  expect(findAccounts('test_user: anna / anna12')).toEqual([{ user: 'anna', password: 'anna12' }])
  expect(findAccounts('merge main / feature')).toEqual([])
  expect(findAccounts('admin / ab')).toEqual([])
  expect(findAccounts('admin / http://x')).toEqual([])
})

test('placeholders are no logins', async () => {
  const placeholders = ['<x>', '***', '$VAR', '{x}', 'a(b', 'process.env.X', 'your-pass', 'YOUR_PASS', 'xxxx', '...', 'Password', 'hasło', 'pass', 'Username', 'login', 'null', 'undefined', 'None', 'true', 'false']
  for (const value of placeholders) expect([value, findAccounts(`user: jan\npassword: ${value}`)]).toEqual([value, []])
  expect(findAccounts(`user: jan\npassword: ${'a'.repeat(65)}`)).toEqual([])
  expect(findAccounts(`user: jan\npassword: ${'a'.repeat(64)}`)).toEqual([{ user: 'jan', password: 'a'.repeat(64) }])
})

test('tables of logins: any of the column names, the rule row skipped, the other cells as the note', async () => {
  const table = (head: string, row: string) => findAccounts(`| ${head} |\n|:--|--:|---|\n| ${row} |`)
  expect(table('Login | Hasło | Rola', 'jan | j123 | admin')).toEqual([{ user: 'jan', password: 'j123', note: 'admin' }])
  expect(table('E-mail | Pass | x', 'a@b.pl | p123 |')).toEqual([{ user: 'a@b.pl', password: 'p123' }])
  expect(table('Użytkownik | Haslo | x', 'ola | o123 | y')).toEqual([{ user: 'ola', password: 'o123', note: 'y' }])
  expect(table('Konto | password | x', 'k1 | k123 | y')).toEqual([{ user: 'k1', password: 'k123', note: 'y' }])
  expect(table('Name | Value | x', 'jan | j123 | y')).toEqual([])
  expect(findAccounts('| user | password |\n|---|---|\n| a1 | b123 |\n\n| a2 | b234 |')).toEqual([{ user: 'a1', password: 'b123' }])
})

test('e-mail logins: on a line about logging in, or any address on a test domain', async () => {
  expect(findLoginEmails('Zaloguj jako jan@firma.pl')).toEqual([{ user: 'jan@firma.pl' }])
  expect(findLoginEmails('log in with Jan.Kowalski+t@Sub.Firma.COM.')).toEqual([{ user: 'Jan.Kowalski+t@Sub.Firma.COM' }])
  expect(findLoginEmails('Konto: a@b.pl')).toEqual([{ user: 'a@b.pl' }])
  expect(findLoginEmails('Napisz na biuro@firma.pl')).toEqual([])
  expect(findLoginEmails('cc: support@example.com, ops@shop.test, x@a.invalid')).toEqual([
    { user: 'support@example.com' },
    { user: 'ops@shop.test' },
    { user: 'x@a.invalid' },
  ])
  expect(findLoginEmails('login: noreply@example.com, No-Reply@shop.local, x@anthropic.com')).toEqual([])
  expect(findLoginEmails('login: a@b.c1 a@b')).toEqual([])
  expect(findLoginEmails('dostęp jako  dev@corp.io')).toEqual([{ user: 'dev@corp.io' }])
  expect(findLoginEmails('najako dev@corp.io')).toEqual([])
})

test('accounts from a seeding command count; from any other command they do not', async () => {
  const out = 'Created account admin / admin123'
  expect(extract(did(bash('npm run db:seed', out))).accounts).toEqual([{ user: 'admin', password: 'admin123' }])
  expect(extract(did(bash('dotnet run -- --Seed', out))).accounts).toEqual([{ user: 'admin', password: 'admin123' }])
  expect(extract(did(bash('npm run reseed', out))).accounts).toEqual([])
})

test('netstat, check rollups and worktree listings in their other shapes', async () => {
  const netstat = 'tcp  0  0 0.0.0.0:22  0.0.0.0:*  LISTEN\ntcp6 0 0 [::]:8080 [::]:* LISTEN\r\nudp 0 0 0.0.0.0:53 0.0.0.0:*'
  expect([...listeningPorts(netstat)]).toEqual([22, 8080])
  expect(
    summarizeChecks([
      { conclusion: 'NEUTRAL' },
      { conclusion: 'SKIPPED' },
      { state: 'success' },
      { conclusion: 'ERROR' },
      { conclusion: 'CANCELLED' },
      { conclusion: 'TIMED_OUT' },
      { conclusion: 'ACTION_REQUIRED' },
      { conclusion: 'STALE' },
      { conclusion: null, status: 'QUEUED' },
    ]),
  ).toEqual({ pass: 3, fail: 4, pending: 2 })
  expect(parseWorktrees('worktree C:/my repo\r\nHEAD abc\r\ndetached\r\n\r\nworktree /bare\nbare\n\nHEAD x\nbranch refs/heads/orphan\n')).toEqual([
    { path: 'C:/my repo', branch: '(detached)' },
    { path: '/bare', branch: undefined },
  ])
})

test('what a command only carries (a heredoc, a script, a quoted message) starts nothing and changes no PR', async () => {
  const fixture = [
    "cat >> tests/x.test.ts <<'TSEOF'",
    "bash('npm run dev -- --port 5173', 'Command running in background with ID: b1.')",
    "bash('gh pr create --fill', 'https://github.com/a.b/c-d/pull/77')",
    'docker compose up -d # https://shop.localhost',
    'TSEOF',
    'claude plugin test .',
  ].join('\n')
  const script = ["python -I - <<'PYEOF'", "print('docker run -p 8080:80 img')", "print('gh pr merge 12')", 'PYEOF'].join('\n')
  const here = ["$doc = @'", 'npm start', "'@", 'Set-Content x.md $doc'].join('\n')
  const out = 'README: `user1..3@example.com` is listed as three accounts; Zaloguj się: admin / admin123'
  const found = extract(
    did(
      bash(fixture, out),
      bash(script, out),
      { tool: 'PowerShell', input: { command: here }, text: out },
      bash('git commit -m "start it with npm run dev, then gh pr merge 5"', out),
      bash("echo 'docker compose up' && grep -n seed README.md", out),
    ),
  )
  expect(found.processes).toEqual([])
  expect(found.prs).toEqual([])
  expect(found.accounts).toEqual([])
})

test('a start, a PR change or a seed after a heredoc, in a chain or behind variables still counts', async () => {
  const found = extract(
    did(
      bash(["cat > .env <<EOF", 'A=1', 'EOF', 'npm run dev'].join('\n')),
      bash('cd app && PORT=3001 node server.js'),
      bash('docker compose -f dev.yml up -d; echo ok'),
      bash('git push && gh pr create --fill', 'https://github.com/acme/shop/pull/9'),
      bash('npm run db:seed', 'Created account admin / admin123'),
    ),
  )
  expect(found.processes.map(p => [p.command, p.status, p.urls.map(u => u.port)])).toEqual([
    ['cat > .env <<EOF', 'started', []],
    ['cd app && PORT=3001 node server.js', 'started', [3001]],
    ['docker compose -f dev.yml up -d; echo ok', 'started', []],
  ])
  expect(found.prs.map(p => p.number)).toEqual([9])
  expect(found.accounts).toEqual([{ user: 'admin', password: 'admin123' }])
})
