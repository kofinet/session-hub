import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const MESSAGES = [
  {
    role: 'assistant' as const,
    text: 'Gotowe — zaloguj się: admin / admin123',
    toolUses: [
      {
        tool_use_id: 't0',
        tool: 'Bash',
        input: { command: 'npm run dev', run_in_background: true },
        text: 'Command running in background with ID: bk1. Output is being written to: C:/tmp/tasks/bk1.output',
      },
      { tool_use_id: 't1', tool: 'Bash', input: { command: 'gh pr create --fill' }, text: 'https://github.com/acme/shop/pull/42' },
      { tool_use_id: 't3', tool: 'Bash', input: { command: 'git worktree add -b feat/y ../repo-y' }, text: 'Preparing worktree' },
      { tool_use_id: 't2', tool: 'Artifact', input: { file_path: 'C:/s/overview.html' }, text: 'https://claude.ai/code/artifact/abc' },
    ],
  },
]

const PR_JSON = JSON.stringify({
  url: 'https://github.com/acme/shop/pull/42',
  number: 42,
  title: 'Add checkout',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }],
})

const answers = (argv: readonly string[]): string | undefined => {
  const cmd = argv.join(' ')
  if (cmd === 'git rev-parse --show-toplevel') return 'C:/repo-wt'
  if (cmd === 'git worktree list --porcelain')
    return 'worktree C:/repo\nbranch refs/heads/main\n\nworktree C:/repo-wt\nbranch refs/heads/feat/x\n\nworktree C:/repo-other\nbranch refs/heads/feat/other\n\nworktree C:/repo-y\nbranch refs/heads/feat/y\n'
  if (cmd.startsWith('gh pr view')) return PR_JSON
  if (cmd === 'netstat -an') return '  TCP    0.0.0.0:5173   0.0.0.0:0   LISTENING'
  return undefined
}

test("/hub shows this session's worktree, PR, process with its later URL, and account", async ($, on) => {
  on('session.messages', () => ({ value: MESSAGES as never }))
  on('session.cwd', () => ({ value: 'C:/repo-wt' }))
  on('fs.read', () => ({ value: '  VITE ready\n  ➜  Local:   http://localhost:5173/\n' as never }))
  on('process.run', ($, e) => {
    const out = answers(e.argv)
    return { value: { exitCode: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '' } as never }
  })
  on('ui.open', ($, e) => ({ value: { id: e.id, isPlaced: true } as never }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'hub', args: '', origin: { kind: 'user' } } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-hub',
      surface,
      component: 'Pane',
      requestId: 'session-hub',
      props: {
        title: 'Session hub',
        isFocused: false,
        bodyColumns: 80,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 60 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: '▶ feat/x' })).toBeDefined()
    // a file link is plain text on the desktop
    expect(await ui.find({ text: 'C:/repo-wt' })).toBeDefined()
    expect(await ui.find({ text: 'C:/repo-y' })).toBeDefined()
    expect(await ui.find({ text: 'C:/repo-other' })).toBeUndefined()
    // the main checkout (C:/repo) is not the session's: no row for it
    expect(await ui.find({ type: 'Text', text: '(main checkout)' })).toBeUndefined()
    expect(await ui.find({ type: 'Link', text: 'acme/shop#42' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  Add checkout' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'review required' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$ npm run dev' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'http://localhost:5173' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  admin / admin123' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'overview' })).toBeDefined()
    await ui.unmount()
  }
})

const DEV_DOC = ['# Dev', '', '| Role | Login | Where |', '|---|---|---|', '| Tenant admin | `admin@shop.local` | admin app |', '', 'Stripe OK: 4242 4242 4242 4242'].join('\n')
const SNAPSHOT = { isRemoteSession: false, worktrees: [], prs: [], processes: [], urls: [], accounts: [], artifacts: [], refreshedAt: 0 }
const PROJECT_STATUS = {
  name: 'shop',
  branch: 'main',
  refreshedAt: 0,
  checks: [
    { key: 'CI', label: 'CI', type: 'workflow', role: 'ci', state: 'ok' },
    {
      key: 'dev',
      label: 'dev',
      type: 'docker',
      role: 'check',
      state: 'ok',
      detail: '3',
      accounts: {
        kind: 'listed',
        doc: 'C:/repo/docs/accounts.md',
        text: DEV_DOC,
        list: [{ user: 'admin@shop.local', note: 'Tenant admin · admin app' }],
      },
    },
    { key: 'staging', label: 'staging', type: 'docker', role: 'check', state: 'skipped', detail: 'off' },
  ],
}

const SESSION_ACCOUNTS = [{ user: 'admin@shop.local' }, { user: 'dev@shop.local', note: 'seeded by this session' }]

test("one Accounts section: a running instance's accounts doc folded under its name, then the session's own, without the instance's again", async ($, on) => {
  on('state.get', ($, e, next) => {
    if (e.key === 'snapshot')
      return { value: { value: { shape: 'snapshot-4', value: { ...SNAPSHOT, accounts: SESSION_ACCOUNTS } }, version: 1 } } as never
    if (e.key === 'project') return { value: { value: { shape: 'project-4', value: PROJECT_STATUS }, version: 1 } } as never
    return next(e)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-hub',
      surface,
      component: 'Pane',
      requestId: 'session-hub',
      props: { title: 'Session hub', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: 'Accounts (2)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  dev@shop.local (no password)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  admin@shop.local (no password)' })).toBeUndefined()
    expect(await ui.find({ key: 'accounts:dev' })).toBeDefined()
    expect(await ui.find({ key: 'accounts:staging' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '    Tenant admin  admin@shop.local  admin app' })).toBeUndefined()

    await ui.press({ key: 'accounts:dev' })
    expect(await ui.find({ type: 'Text', text: '    Dev' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '    Role          Login             Where' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '    Tenant admin  admin@shop.local  admin app' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '    Stripe OK: 4242 4242 4242 4242' })).toBeDefined()

    await ui.press({ key: 'accounts:dev' })
    expect(await ui.find({ type: 'Text', text: '    Stripe OK: 4242 4242 4242 4242' })).toBeUndefined()
    await ui.unmount()
  }
})

test('no Accounts section when neither the session nor a running instance has an account', async ($, on) => {
  on('state.get', ($, e, next) => {
    if (e.key === 'snapshot') return { value: { value: { shape: 'snapshot-4', value: SNAPSHOT }, version: 1 } } as never
    return next(e)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-hub',
      surface,
      component: 'Pane',
      requestId: 'session-hub',
      props: { title: 'Session hub', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: 'Accounts (0)' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '  sesja nie podała żadnego konta' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'URLs (0)' })).toBeDefined()
    await ui.unmount()
  }
})

const withInstance = (accounts: unknown) => ({
  ...PROJECT_STATUS,
  checks: [{ key: 'dev', label: 'dev', type: 'docker', role: 'check', state: 'ok', detail: '3', accounts }],
})

const mountPane = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'session-hub',
    surface,
    component: 'Pane',
    requestId: 'session-hub',
    props: { title: 'Session hub', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  })

test("an instance whose accounts doc is missing still shows its group, saying the doc is not there", async ($, on) => {
  const project = withInstance({ kind: 'missing', doc: 'C:/repo/docs/LOCAL_ACCOUNT.md' })
  on('state.get', ($, e, next) => {
    if (e.key === 'snapshot') return { value: { value: { shape: 'snapshot-4', value: SNAPSHOT }, version: 1 } } as never
    if (e.key === 'project') return { value: { value: { shape: 'project-4', value: project }, version: 1 } } as never
    return next(e)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'accounts:dev' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(no document)' })).toBeDefined()
    await ui.press({ key: 'accounts:dev' })
    if (surface === 'terminal') expect(await ui.find({ type: 'Link', text: 'C:/repo/docs/LOCAL_ACCOUNT.md' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '    no such document, or it cannot be read' })).toBeDefined()
    await ui.press({ key: 'accounts:dev' })
    await ui.unmount()
  }
})

test("the session's password for a login the instance's doc also lists stays in view", async ($, on) => {
  const project = withInstance({ kind: 'listed', doc: 'C:/repo/docs/accounts.md', text: 'admin / admin123', list: [{ user: 'admin', password: 'admin123' }] })
  const session = [{ user: 'admin', password: 'NewPass1' }]
  on('state.get', ($, e, next) => {
    if (e.key === 'snapshot') return { value: { value: { shape: 'snapshot-4', value: { ...SNAPSHOT, accounts: session } }, version: 1 } } as never
    if (e.key === 'project') return { value: { value: { shape: 'project-4', value: project }, version: 1 } } as never
    return next(e)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'Accounts (2)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  admin / NewPass1' })).toBeDefined()
    await ui.unmount()
  }
})

test("the status line counts the accounts the pane lists: the instances' and the session's own", async ($, on) => {
  let status: string | undefined
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Zaloguj się: admin / NewPass1', toolUses: [] }] as never }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } as never }))
  on('ui.open', ($, e) => ({ value: { id: e.id, isPlaced: true } as never }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('state.get', ($, e, next) => {
    if (e.key === 'project') return { value: { value: { shape: 'project-4', value: PROJECT_STATUS }, version: 1 } } as never
    return next(e)
  })

  await $.command.run({ command: 'hub', args: '', origin: { kind: 'user' } } as never)

  expect(status).toBe('hub: 2 accounts')
})

test('a login two running instances list from the same doc is counted once', async ($, on) => {
  const list = [{ user: 'admin', password: 'admin123' }, { user: 'support', password: 'support1' }]
  const instance = (label: string) => ({
    key: label,
    label,
    type: 'docker',
    role: 'check',
    state: 'ok',
    detail: '3',
    accounts: { kind: 'listed', doc: 'C:/repo/docs/accounts.md', text: 'admin / admin123\nsupport / support1', list },
  })
  const project = { ...PROJECT_STATUS, checks: [instance('dev'), instance('sim')] }
  on('state.get', ($, e, next) => {
    if (e.key === 'snapshot') return { value: { value: { shape: 'snapshot-4', value: SNAPSHOT }, version: 1 } } as never
    if (e.key === 'project') return { value: { value: { shape: 'project-4', value: project }, version: 1 } } as never
    return next(e)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'Accounts (2)' })).toBeDefined()
    await ui.unmount()
  }
})

test("an instance's accounts unfold and fold again on two quick presses", async ($, on) => {
  on('state.get', ($, e, next) => {
    if (e.key === 'snapshot') return { value: { value: { shape: 'snapshot-4', value: SNAPSHOT }, version: 1 } } as never
    if (e.key === 'project') return { value: { value: { shape: 'project-4', value: PROJECT_STATUS }, version: 1 } } as never
    return next(e)
  })
  const ui = await mountPane($, 'terminal')
  await Promise.all([ui.press({ key: 'accounts:dev' }), ui.press({ key: 'accounts:dev' })])
  expect(await ui.find({ type: 'Text', text: '    Stripe OK: 4242 4242 4242 4242' })).toBeUndefined()
  await ui.press({ key: 'accounts:dev' })
  expect(await ui.find({ type: 'Text', text: '    Stripe OK: 4242 4242 4242 4242' })).toBeDefined()
  await ui.unmount()
})

test("the session's own account stays in view after the session repeats the doc's long table", async ($, on) => {
  const docRows = Array.from({ length: 12 }, (_, i) => ({ user: `tester${i + 1}`, password: `secret${i + 1}` }))
  const table = ['| Login | Password |', '|---|---|', ...docRows.map(a => `| ${a.user} | ${a.password} |`)].join('\n')
  const project = withInstance({ kind: 'listed', doc: 'C:/repo/docs/accounts.md', text: table, list: docRows })
  let status: string | undefined
  on('session.messages', () => ({
    value: [
      { role: 'assistant', text: 'Zaloguj się: dev / devpass1', toolUses: [] },
      { role: 'assistant', text: table, toolUses: [] },
    ] as never,
  }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } as never }))
  on('ui.open', ($, e) => ({ value: { id: e.id, isPlaced: true } as never }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('state.get', ($, e, next) => {
    if (e.key === 'project') return { value: { value: { shape: 'project-4', value: project }, version: 1 } } as never
    return next(e)
  })

  await $.command.run({ command: 'hub', args: '', origin: { kind: 'user' } } as never)

  expect(status).toBe('hub: 13 accounts')
})

const MAIN_CHECKOUT = 'C:/repo'
const SESSION_WORKTREE = 'C:/repo/.claude/worktrees/accounts'
const HUB_SETTINGS_FILE = 'C:/hub/settings.json'
const DEV_STACK = { type: 'docker', label: 'dev', containerPrefixes: ['shop-dev-'], accounts: 'docs/accounts.md' }
const hubSettings = (checks: readonly unknown[]) =>
  JSON.stringify({ projects: [{ name: 'shop', match: { remote: 'acme/shop' }, branch: 'main', checks }] })
const ACCOUNTS_DOC = ['| Role | Login | Password |', '|---|---|---|', '| Admin | admin | admin123 |', '| Support | support | support1 |'].join('\n')

/** A session in `cwd` of the `shop` repository (or the one `origin` names) with its `dev` stack running, the files given on disk. */
const shopSession = (
  on: On,
  cwd: string,
  files: Readonly<Record<string, string>>,
  checks: readonly unknown[] = [DEV_STACK],
  origin = 'https://github.com/acme/shop.git',
) => {
  const disk = new Map<string, string>([[HUB_SETTINGS_FILE, hubSettings(checks)], ...Object.entries(files)])
  const said = new Map<string, string>([
    ['git rev-parse --show-toplevel', cwd],
    ['git worktree list --porcelain', `worktree ${MAIN_CHECKOUT}\n\nworktree ${SESSION_WORKTREE}`],
    ['git remote get-url origin', origin],
    ['docker ps --format {{.Names}}\t{{.State}}\t{{.Status}}', 'shop-dev-web\trunning\tUp 1 minute'],
  ])
  const shown = { status: undefined as string | undefined }
  mock.env(on, { SESSION_HUB_SETTINGS: HUB_SETTINGS_FILE })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined as never }))
  on('tool.register', () => ({ value: undefined as never }))
  // the engine hands the hooks a Windows path with backslashes
  const onDisk = (path: string) => disk.get(path.split('\\').join('/'))
  on('fs.exists', ($, e) => ({ value: onDisk(e.path) !== undefined }))
  on('fs.read', ($, e, next) => {
    const text = onDisk(e.path)
    return text === undefined ? next(e) : { value: text }
  })
  on('session.cwd', () => ({ value: cwd }))
  on('session.messages', () => ({ value: [] as never }))
  on('process.run', ($, e) => {
    const stdout = said.get(e.argv.join(' '))
    return { value: (stdout === undefined ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout, stderr: '' }) as never }
  })
  on('ui.open', ($, e) => ({ value: { id: e.id, isPlaced: true } as never }))
  on('ui.status', ($, e) => {
    shown.status = e.text
    return { value: undefined }
  })
  return shown
}

test("the status line counts a running instance's accounts as soon as the band reads them", async ($, on) => {
  const shown = shopSession(on, MAIN_CHECKOUT, { [`${MAIN_CHECKOUT}/docs/accounts.md`]: ACCOUNTS_DOC })
  const clock = mock.clock(on)
  await $.session.start({ cwd: MAIN_CHECKOUT, surface: 'terminal', isInteractive: true })

  await clock.advance(1_000)

  expect(shown.status).toBe('hub: 2 accounts')
})

test("an instance's accounts doc is read from the worktree the session works in", async ($, on) => {
  shopSession(on, SESSION_WORKTREE, { [`${SESSION_WORKTREE}/docs/accounts.md`]: ACCOUNTS_DOC })
  const clock = mock.clock(on)
  await $.session.start({ cwd: SESSION_WORKTREE, surface: 'terminal', isInteractive: true })

  await clock.advance(1_000)

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '(no document)' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '(2)' })).toBeDefined()
  await ui.unmount()
})

test("an environment's accounts doc (production, staging) is listed under its name, with no local instance running", async ($, on) => {
  const prod = { type: 'http', label: 'prod', urls: ['https://shop.example/'], accounts: 'docs/test_data_prod.md' }
  const staging = { type: 'http', label: 'staging', urls: ['https://staging.shop.example/'], accounts: 'docs/test_data_staging.md' }
  shopSession(on, MAIN_CHECKOUT, { [`${MAIN_CHECKOUT}/docs/test_data_prod.md`]: ACCOUNTS_DOC }, [prod, staging])
  on('http.fetch', () => ({ value: { ok: true, status: 200 } as never }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: MAIN_CHECKOUT, surface: 'terminal', isInteractive: true })

  await clock.advance(1_000)

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'accounts:prod' })).toBeDefined()
  expect(await ui.find({ key: 'accounts:staging' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '(2)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '(no document)' })).toBeDefined()
  await ui.press({ key: 'accounts:prod' })
  expect(await ui.find({ type: 'Link', text: `${MAIN_CHECKOUT}/docs/test_data_prod.md` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '    Admin    admin    admin123' })).toBeDefined()
  await ui.unmount()
})

test("a long accounts doc is cut in the pane, saying how many lines the document still has", async ($, on) => {
  const text = Array.from({ length: 230 }, (_, i) => `line ${i + 1}`).join('\n')
  const project = withInstance({ kind: 'listed', doc: 'C:/repo/docs/accounts.md', text, list: [] })
  on('state.get', ($, e, next) => {
    if (e.key === 'snapshot') return { value: { value: { shape: 'snapshot-4', value: SNAPSHOT }, version: 1 } } as never
    if (e.key === 'project') return { value: { value: { shape: 'project-4', value: project }, version: 1 } } as never
    return next(e)
  })
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'accounts:dev' })
  expect(await ui.find({ type: 'Text', text: '    line 200' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '    line 201' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '    … 30 more lines in the document' })).toBeDefined()
  await ui.unmount()
})

test("an empty accounts doc says so when unfolded", async ($, on) => {
  const project = withInstance({ kind: 'listed', doc: 'C:/repo/docs/accounts.md', text: '\n\n', list: [] })
  on('state.get', ($, e, next) => {
    if (e.key === 'snapshot') return { value: { value: { shape: 'snapshot-4', value: SNAPSHOT }, version: 1 } } as never
    if (e.key === 'project') return { value: { value: { shape: 'project-4', value: project }, version: 1 } } as never
    return next(e)
  })
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'accounts:dev' })
  expect(await ui.find({ type: 'Text', text: '    the document is empty' })).toBeDefined()
  await ui.unmount()
})

test('a repository with no settings is told once that /session-hub:modinstal configures it', async ($, on) => {
  const toasts: string[] = []
  shopSession(on, MAIN_CHECKOUT, {}, [DEV_STACK], 'https://github.com/acme/new-app.git')
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) as never }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined as never }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined as never }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: MAIN_CHECKOUT, surface: 'terminal', isInteractive: true })

  await clock.advance(1_000)
  await clock.advance(120_000)

  expect(toasts).toEqual(['session-hub: this project has no settings. /session-hub:modinstal sets up the band, the guards and the test data.'])
})

test('in Polish, when the settings ask for it: the pane and the setup hint', async ($, on) => {
  const toasts: string[] = []
  shopSession(on, MAIN_CHECKOUT, { [HUB_SETTINGS_FILE]: '{"language": "pl", "projects": []}' }, [], 'https://github.com/acme/new-app.git')
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) as never }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined as never }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined as never }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: MAIN_CHECKOUT, surface: 'terminal', isInteractive: true })

  await clock.advance(1_000)

  expect(toasts).toEqual(['session-hub: ten projekt nie ma ustawień. /session-hub:modinstal skonfiguruje pasek, strażników i dane testowe.'])
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Procesy (0)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  sesja nic nie uruchomiła' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Processes (0)' })).toBeUndefined()
  await ui.unmount()
})
