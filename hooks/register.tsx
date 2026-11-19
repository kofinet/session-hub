import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Account, Process, PullRequest, Snapshot, Url, Worktree } from '../types'
import { extract, fileHref, listeningPorts, localUrls, parseWorktrees, pullRepo, summarizeChecks, taskNotifications } from './extract'
import type { CheckRun, FoundPr, FoundProcess, FoundUrl, Msg } from './extract'
import { docFacts } from './doc'
import { afterTurn, registerProject, startProject } from './project'
import { run } from './run'
import { DEFAULT_LANGUAGE, textsFor } from './i18n'
import { ENV_PANE_PREFIX, envPane, isLive, paneAccounts, PROJECT_SHAPE, showStatus, SNAPSHOT_SHAPE } from './status'

const PANE = 'session-hub'
const snapshot = atom({ plugin: 'session-hub', key: 'snapshot' } as const, null, { shape: SNAPSHOT_SHAPE })
const isAutoOpened = atom({ plugin: 'session-hub', key: 'isAutoOpened' } as const, false)
// project.tsx writes it; the pane reads its instances' accounts.
const projectStatus = atom({ plugin: 'session-hub', key: 'project' } as const, null, { shape: PROJECT_SHAPE })
/** background tasks' ends the session was notified of outside its messages: task id → status */
const taskEnds = atom({ plugin: 'session-hub', key: 'taskEnds' } as const, {} as Record<string, string>)
const language = atom({ plugin: 'session-hub', key: 'language' } as const, DEFAULT_LANGUAGE)

const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk'])
const MAX_AGENTS = 20
const MAX_FINISHED = 5
const OUTPUT_TAIL = 200_000

const norm = (p: string) => {
  const slashed = p.split('\\').join('/')
  return (slashed.endsWith('/') ? slashed.slice(0, -1) : slashed).toLowerCase()
}
const samePath = (a: string, b: string) => norm(a) === norm(b)
/** `typed` is absolute, or relative as `git worktree add` got it */
const isPathOf = (path: string, typed: string) => {
  const typedNorm = norm(typed)
  const t = typedNorm.startsWith('./') ? typedNorm.slice(2) : typedNorm
  let below = t
  while (below.startsWith('../')) below = below.slice(3)
  return norm(path) === t || norm(path).endsWith(`/${below}`)
}

/** The session's own worktree first, then the ones it created or entered; never the rest of the repo's. */
const readWorktrees = async ($: EngineInterface, cwd: string, typed: readonly string[]): Promise<Worktree[]> => {
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'], cwd)
  if (top === undefined) return []
  const list = parseWorktrees((await run($, ['git', 'worktree', 'list', '--porcelain'], cwd)) ?? '')
  if (list.length === 0) {
    const branch = await run($, ['git', 'branch', '--show-current'], cwd)
    return [{ path: top, branch: branch || undefined, isCurrent: true, isMain: true, ...(await readRemote($, top)) }]
  }
  const shown = list
    .map((w, i) => ({ ...w, isCurrent: samePath(w.path, top), isMain: i === 0 }))
    .filter(w => w.isCurrent || typed.some(t => isPathOf(w.path, t)))
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
  return Promise.all(shown.map(async w => ({ ...w, ...(await readRemote($, w.path)) })))
}

/** Claude Code on the web runs the session in a cloud container and says so in `CLAUDE_CODE_REMOTE`. */
const isRemoteSession = async ($: EngineInterface): Promise<boolean> => {
  try {
    return (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true'
  } catch {
    return false
  }
}

/** The branch's upstream and `ahead`/`behind` against it; nothing when it was never pushed. */
const readRemote = async ($: EngineInterface, path: string): Promise<Pick<Worktree, 'remote'>> => {
  const upstream = await run($, ['git', '-C', path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (upstream === undefined || upstream === '') return {}
  const counts = await run($, ['git', '-C', path, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
  const [ahead = 0, behind = 0] = (counts ?? '').split('\t').map(Number)
  return { remote: { upstream, ahead, behind } }
}

const readPr = async ($: EngineInterface, target: string | undefined, cwd: string): Promise<PullRequest | undefined> => {
  const argv = ['gh', 'pr', 'view', ...(target ? [target] : []), '--json', 'url,number,title,state,isDraft,reviewDecision,statusCheckRollup']
  const out = await run($, argv, cwd)
  if (out === undefined) return undefined
  try {
    const pr = JSON.parse(out) as {
      url: string
      number: number
      title: string
      state: string
      isDraft: boolean
      reviewDecision?: string
      statusCheckRollup?: CheckRun[]
    }
    const repo = pullRepo(pr.url)
    return {
      url: pr.url,
      repo,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: pr.isDraft,
      review: pr.reviewDecision || undefined,
      checks: pr.statusCheckRollup?.length ? summarizeChecks(pr.statusCheckRollup) : undefined,
    }
  } catch {
    return undefined
  }
}

const fallbackPr = (p: FoundPr): PullRequest | undefined =>
  p.url !== undefined && p.repo !== undefined && p.number !== undefined
    ? { url: p.url, repo: p.repo, number: p.number }
    : undefined

/** The main conversation and the transcripts of the subagents it launched. */
const transcripts = async ($: EngineInterface): Promise<{ main: Msg[]; agents: Msg[] }> => {
  const main = (await $.session.messages()) as unknown as Msg[]
  const ids = [...new Set(main.flatMap(m => m.toolUses.map(u => u.agentId)).filter(id => id !== undefined))]
  const agents = await Promise.all(
    ids.slice(-MAX_AGENTS).map(async agentId => {
      try {
        const found = await $.session.messages({ agentId })
        return Array.isArray(found) ? (found as unknown as Msg[]) : []
      } catch {
        return []
      }
    }),
  )
  return { main, agents: agents.flat() }
}

/** A running background task prints its addresses after it started: read its output file. */
const withLaterUrls = async ($: EngineInterface, p: FoundProcess): Promise<FoundUrl[]> => {
  if (p.status !== 'running' || p.outputFile === undefined) return p.urls
  try {
    const text = await $.fs.read(p.outputFile)
    const later = localUrls(text.slice(-OUTPUT_TAIL)).filter(u => !p.urls.some(k => k.url === u.url))
    return [...p.urls, ...later]
  } catch {
    return p.urls
  }
}

let inFlight: Promise<void> | undefined

const refresh = ($: EngineInterface): Promise<void> => {
  inFlight ??= (async () => {
    try {
      const cwd = await $.session.cwd()
      const { main, agents } = await transcripts($)
      const found = extract(main, agents, await read($, taskEnds))

      const processUrls = await Promise.all(found.processes.map(p => withLaterUrls($, p)))
      const hasPorts = processUrls.some(u => u.length > 0) || found.urls.length > 0
      const [netstat, worktrees] = await Promise.all([
        hasPorts ? run($, ['netstat', '-an']) : Promise.resolve(undefined),
        readWorktrees($, cwd, found.worktreePaths),
      ])
      const listening = netstat === undefined ? undefined : listeningPorts(netstat)
      const alive = (u: FoundUrl): Url => ({ ...u, isAlive: listening ? listening.has(u.port) : null })

      const current = worktrees.find(w => w.isCurrent)
      const ownPr =
        current?.branch !== undefined && !DEFAULT_BRANCHES.has(current.branch) && current.branch !== '(detached)'
          ? await readPr($, undefined, cwd)
          : undefined
      const made = found.prs.filter(p => p.url === undefined || p.url !== ownPr?.url)
      const prs = (await Promise.all(made.map(async p => (await readPr($, p.ref, cwd)) ?? fallbackPr(p))))
        .filter(p => p !== undefined)
        .filter((p, i, all) => p.url !== ownPr?.url && all.findIndex(q => q.url === p.url) === i)
      if (ownPr) prs.unshift({ ...ownPr, isOwn: true })

      const processes: Process[] = found.processes.map((p, i) => ({
        id: p.id,
        command: p.command,
        status: p.status,
        isBackground: p.isBackground,
        urls: (processUrls[i] ?? p.urls).map(alive),
      }))
      const live = processes.filter(isLive)
      const finished = processes.filter(p => !isLive(p)).slice(-MAX_FINISHED)
      const shownUrls = new Set(processes.flatMap(p => p.urls.map(u => u.url)))

      const next: Snapshot = {
        isRemoteSession: await isRemoteSession($),
        worktrees,
        prs,
        processes: [...live.reverse(), ...finished.reverse()],
        urls: found.urls.filter(u => !shownUrls.has(u.url)).map(alive),
        accounts: found.accounts,
        artifacts: found.artifacts,
        refreshedAt: await $.clock.now(),
      }
      await update($, snapshot, () => next)
      await showStatus($)

      // once per session, at its start: the hub is in view before the session did anything
      if (!(await read($, isAutoOpened))) {
        await update($, isAutoOpened, () => true)
        void $.ui.open({ id: PANE, title: 'Session hub' })
      }
    } finally {
      inFlight = undefined
    }
  })()
  return inFlight
}

const time = (ms: number) => new Date(ms).toTimeString().slice(0, 8)

const STATUS: Record<Process['status'], { mark: string; color: string }> = {
  running: { mark: '●', color: 'success' },
  started: { mark: '●', color: 'success' },
  completed: { mark: '✓', color: 'inactive' },
  failed: { mark: '✗', color: 'error' },
  killed: { mark: '■', color: 'inactive' },
}

export const register: Register = on => {
  registerProject(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hub',
      description: 'Session hub: worktree/branch, PRs, processes, URLs and accounts of this session',
    })
    $.clock.every(60_000, () => void refresh($))
    $.clock.after(500, () => void refresh($))
    await startProject($)
    return next(e)
  })

  // A background task's end, delivered into a running turn, reaches the session as a prompt, not a message.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const ends = taskNotifications(e.text)
      if (ends.length > 0) {
        await update($, taskEnds, known => ({ ...known, ...Object.fromEntries(ends.map(n => [n.id, n.status])) }))
        $.clock.after(50, () => void refresh($))
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      $.clock.after(50, () => void refresh($))
      await afterTurn($)
    }
    return next(e)
  })

  on('command.run', { command: 'hub' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Session hub' })
    return { text: 'Session hub opened.' }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId.startsWith(ENV_PANE_PREFIX)) return renderEnvironment($, e)
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const t = textsFor(await read($, language)).pane

    const header = (title: string, count: number) => (
      <Text bold color="claude">
        {title} <Text dimColor>({count})</Text>
      </Text>
    )
    const empty = (text: string) => <Text dimColor>  {text}</Text>
    const urlLine = (u: Url, indent: string) => (
      <Text>
        {indent}
        <Text color={u.isAlive === null ? 'inactive' : u.isAlive ? 'success' : 'error'}>{u.isAlive === false ? '○' : '●'} </Text>
        <Link href={u.url}>{u.url}</Link>
        {u.isAlive === false && <Text dimColor> ({t.notListening})</Text>}
      </Text>
    )

    const accountLine = (a: Account, indent: string) => (
      <Box flexDirection="column">
        <Text>
          {indent}
          <Text color="suggestion">{a.user}</Text>
          {a.password !== undefined ? (
            <Text>
              <Text dimColor> / </Text>
              <Text color="warning">{a.password}</Text>
            </Text>
          ) : (
            <Text dimColor> ({t.noPassword})</Text>
          )}
        </Text>
        {a.note !== undefined && (
          <Text dimColor wrap="truncate-end">
            {indent}
            {'  '}
            {a.note}
          </Text>
        )}
      </Box>
    )
    if (snap === null) return <Text dimColor>{t.collecting}</Text>

    const { own: sessionAccounts, count: accountCount } = paneAccounts(await read($, projectStatus), snap.accounts)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {header(t.worktrees, snap.worktrees.length)}
          <Text dimColor>  {t.session(snap.isRemoteSession)}</Text>
          {snap.worktrees.length === 0 && empty(t.notGit)}
          {snap.worktrees.map(w => (
            <Box flexDirection="column">
              <Text>
                <Text color={w.isCurrent ? 'success' : 'inactive'}>{w.isCurrent ? '▶ ' : '  '}</Text>
                <Text color="permission" bold>
                  {w.branch ?? '?'}
                </Text>
                {w.isMain && <Text dimColor> ({t.mainCheckout})</Text>}
              </Text>
              <Text>
                {'  '}
                {w.remote === undefined ? (
                  <Text color="warning">{t.notPushed}</Text>
                ) : (
                  <Text>
                    <Text dimColor>→ {w.remote.upstream}</Text>
                    {w.remote.ahead === 0 && w.remote.behind === 0 && <Text color="success"> {t.synced}</Text>}
                    {w.remote.ahead > 0 && <Text color="warning"> ↑{w.remote.ahead}</Text>}
                    {w.remote.behind > 0 && <Text color="warning"> ↓{w.remote.behind}</Text>}
                  </Text>
                )}
              </Text>
              <Text wrap="truncate-start">
                {'  '}
                <Link href={fileHref(w.path)}>{w.path}</Link>
              </Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          {header(t.pullRequests, snap.prs.length)}
          {snap.prs.length === 0 && empty(t.noPrs)}
          {snap.prs.map(p => {
            const color =
              p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'error' : p.isDraft ? 'inactive' : 'success'
            const label = p.state === undefined ? '?' : p.isDraft && p.state === 'OPEN' ? 'DRAFT' : p.state
            return (
              <Box flexDirection="column">
                <Text>
                  <Text color={color} bold>
                    [{label}]
                  </Text>{' '}
                  <Link href={p.url}>
                    {p.repo}#{p.number}
                  </Link>
                  {p.isOwn && <Text color="claude"> {t.thisBranch}</Text>}
                </Text>
                {p.title !== undefined && (
                  <Text wrap="truncate-end">
                    {'  '}
                    {p.title}
                  </Text>
                )}
                {(p.checks || p.review) && (
                  <Text>
                    {'  '}
                    {p.checks && (
                      <Text>
                        <Text color="success">✓{p.checks.pass}</Text>{' '}
                        <Text color={p.checks.fail > 0 ? 'error' : 'inactive'}>✗{p.checks.fail}</Text>{' '}
                        <Text color={p.checks.pending > 0 ? 'warning' : 'inactive'}>…{p.checks.pending}</Text>{' '}
                      </Text>
                    )}
                    {p.review && <Text dimColor>{p.review.toLowerCase().split('_').join(' ')}</Text>}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column">
          {header(t.processes, snap.processes.length)}
          {snap.processes.length === 0 && empty(t.noProcesses)}
          {snap.processes.map(p => {
            const s = STATUS[p.status]
            const isDone = p.status === 'completed' || p.status === 'killed' || p.status === 'failed'
            return (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color={s.color}>{s.mark} </Text>
                  <Text dimColor={isDone}>$ {p.command}</Text>
                </Text>
                <Text dimColor>
                  {'  '}
                  {t.status[p.status]}
                  {p.id !== undefined && ` · ${p.id}`}
                  {p.isBackground ? ` · ${t.background}` : ''}
                </Text>
                {!isDone && p.urls.map(u => urlLine(u, '  '))}
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column">
          {header(t.urls, snap.urls.length)}
          {snap.urls.length === 0 && empty(t.noUrls)}
          {snap.urls.map(u => urlLine(u, ''))}
        </Box>

        {sessionAccounts.length > 0 && (
          <Box flexDirection="column">
            {header(t.accounts, accountCount)}
            {sessionAccounts.map(a => accountLine(a, '  '))}
          </Box>
        )}

        {snap.artifacts.length > 0 && (
          <Box flexDirection="column">
            {header(t.artifacts, snap.artifacts.length)}
            {snap.artifacts.map(a => (
              <Text wrap="truncate-end">
                <Text dimColor>{a.kind === 'artifact' ? '◆ ' : a.kind === 'doc' ? '▤ ' : a.kind === 'link' ? '↗ ' : '▫ '}</Text>
                <Link href={a.href}>{a.label}</Link>
                {a.detail !== undefined && <Text dimColor> {a.detail}</Text>}
              </Text>
            ))}
          </Box>
        )}

        <Box>
          <Button key="refresh" label={t.refresh} hotkey="r" onPress={() => refresh($)} />
          <Text dimColor> {time(snap.refreshedAt)}</Text>
        </Box>
      </Box>
    )
  })
}

/** how a document's account note joins the cells of its row: the first one is the account's role */
const NOTE_SEPARATOR = ' · '
const withoutSlash = (url: string) => (url.endsWith('/') ? url.slice(0, -1) : url)

/**
 * An environment's tab: its links (the addresses from the settings, the document), then only the document's data, by
 * kind, one short line each: accounts with their role, addresses, bank accounts, companies, cards. Its prose stays in
 * the document, a click away.
 */
async function renderEnvironment($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0] & { requestId: string }) {
  const { Box, Text, Link } = $.ui.resolve(e)
  const t = textsFor(await read($, language))
  const status = await read($, projectStatus)
  const check = status?.checks.find(c => envPane(c.label) === e.requestId && c.accounts !== undefined)
  const accounts = check?.accounts
  if (check === undefined || accounts === undefined) return <Text dimColor>{t.env.notRunning}</Text>

  const heading = (title: string, count?: number) => (
    <Text bold color="claude">
      {title}
      {count !== undefined && <Text dimColor> ({count})</Text>}
    </Text>
  )
  const links = (
    <Box flexDirection="column">
      {heading(t.env.links)}
      {(check.urls ?? []).map(url => (
        <Text>
          {'  '}
          <Link href={url}>{url}</Link>
        </Text>
      ))}
      <Text wrap="truncate-start">
        {'  '}
        <Text dimColor>{t.env.document}: </Text>
        <Link href={fileHref(accounts.doc)}>{accounts.doc}</Link>
      </Text>
    </Box>
  )
  if (accounts.kind === 'missing') {
    return (
      <Box flexDirection="column" gap={1}>
        {links}
        <Text dimColor>{t.pane.documentMissing}</Text>
      </Box>
    )
  }

  const list = accounts.list
  const hasPasswords = list.some(a => a.password !== undefined)
  const loginWidth = Math.max(0, ...list.map(a => a.user.length))
  const passwordWidth = Math.max(0, ...list.map(a => (a.password ?? '').length))
  const facts = docFacts(accounts.text)
  const linked = new Set((check.urls ?? []).map(withoutSlash))
  const urls = facts.urls.filter(u => !linked.has(withoutSlash(u.value)))
  const groups = [
    { title: t.env.bankAccounts, facts: facts.bankAccounts },
    { title: t.env.companies, facts: facts.companies },
    { title: t.env.cards, facts: facts.cards },
  ].filter(g => g.facts.length > 0)
  const note = (text: string | undefined) => text !== undefined && <Text dimColor>  {text}</Text>

  return (
    <Box flexDirection="column" gap={1}>
      {links}
      {check.type === 'docker' && check.state === 'skipped' && <Text color="warning">{t.env.stackOff}</Text>}
      <Box flexDirection="column">
        {heading(t.pane.accounts, list.length)}
        {list.length === 0 && <Text dimColor>  {t.env.noAccounts}</Text>}
        {list.map(a => (
          <Text wrap="truncate-end">
            {'  '}
            <Text color="suggestion">{a.user.padEnd(loginWidth)}</Text>
            {hasPasswords && (
              <Text>
                {'  '}
                <Text color="warning">{(a.password ?? '').padEnd(passwordWidth)}</Text>
              </Text>
            )}
            {note(a.note?.split(NOTE_SEPARATOR)[0])}
          </Text>
        ))}
      </Box>
      {urls.length > 0 && (
        <Box flexDirection="column">
          {heading(t.pane.urls, urls.length)}
          {urls.map(u => (
            <Text wrap="truncate-end">
              {'  '}
              <Link href={u.value}>{u.value}</Link>
              {note(u.note)}
            </Text>
          ))}
        </Box>
      )}
      {groups.map(g => {
        const width = Math.max(...g.facts.map(f => f.value.length))
        return (
          <Box flexDirection="column">
            {heading(g.title, g.facts.length)}
            {g.facts.map(f => (
              <Text wrap="truncate-end">
                {'  '}
                <Text color="suggestion">{f.value.padEnd(width)}</Text>
                {note(f.note)}
              </Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}
