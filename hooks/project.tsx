import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CheckState, CheckStatus, InstanceAccounts, ProjectStatus } from '../types'
import { cow, cowSays, outputText } from './cow'
import { detectionFacts } from './detect'
import { docAccounts } from './extract'
import { isInMainCheckout, migrationClash, migrationTarget, mutatingGitCalls, padNumber, worktreePaths } from './guards'
import type { Listing } from './guards'
import {
  bandGroups,
  DOCKER_PS_FORMAT,
  dockerFacts,
  GH_RUN_FIELDS,
  isCurlOk,
  newest,
  notices,
  ownContainers,
  parseContainers,
  parseRuns,
  repoPath,
  workflowFacts,
} from './ops'
import type { Container, GhRun, Sound } from './ops'
import { run } from './run'
import { DEFAULT_SETTINGS, findProject, parseProject, parseSettings, withProject } from './settings'
import type { Check, Project, Settings } from './settings'
import { DEFAULT_LANGUAGE, parseLanguage, textsFor } from './i18n'
import type { Texts } from './i18n'
import { openEnvironmentTabs, PROJECT_SHAPE, showStatus } from './status'

type On = Parameters<Register>[0]

const projectStatus = atom({ plugin: 'session-hub', key: 'project' } as const, null, { shape: PROJECT_SHAPE })
// the settings' language: the band speaks it; register.tsx and status.ts read it too
const language = atom({ plugin: 'session-hub', key: 'language' } as const, DEFAULT_LANGUAGE)

const REFRESH_MS = 60_000
const MIN_GAP_MS = 20_000
const COMMAND_TIMEOUT_MS = 120_000
/** configures a new project in one pass: the band, the guards and the test data documents */
const INSTALL_COMMAND = '/session-hub:modinstal'
const DETECT_TOOL = 'mcp__session-hub__project_detect'
const SAVE_TOOL = 'mcp__session-hub__project_save'

type Context = {
  settings: Settings
  settingsFile?: string
  project?: Project
  mainRoot?: string
  /** the checkout the session works in: the main checkout or one of its worktrees */
  sessionRoot?: string
  origin?: string
  roots: string[]
}

let context: Context | undefined
let previous: ProjectStatus | undefined
let lastRefresh = 0
let inFlight: Promise<void> | undefined
let reportedProblems = ''
/** command checks run on their own clock: the last result per check key, and the ones running now */
const commandResults = new Map<string, { at: number; state: CheckState }>()
const commandsRunning = new Set<string>()

async function settingsPath($: EngineInterface): Promise<string | undefined> {
  try {
    const explicit = await $.env.get('SESSION_HUB_SETTINGS')
    if (explicit !== undefined && explicit !== '') return explicit
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    return home === undefined ? undefined : `${home}/.claude/session-hub/settings.local.json`
  } catch {
    return undefined
  }
}

async function readText($: EngineInterface, path: string | undefined): Promise<string | undefined> {
  try {
    return path !== undefined && (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
  } catch {
    return undefined
  }
}

async function loadContext($: EngineInterface): Promise<Context> {
  const settingsFile = await settingsPath($)
  const { settings, problems } = parseSettings(await readText($, settingsFile))
  const said = problems.join('; ')
  if (said !== '' && said !== reportedProblems) $.ui.toast(`session-hub: ${said}`)
  reportedProblems = said

  const cwd = await $.session.cwd()
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'], cwd)
  if (top === undefined) return { settings, settingsFile, roots: [] }
  const roots = worktreePaths((await run($, ['git', 'worktree', 'list', '--porcelain'], cwd)) ?? '')
  const mainRoot = roots[0] ?? top
  const origin = await run($, ['git', 'remote', 'get-url', 'origin'], cwd)
  return {
    settings,
    settingsFile,
    mainRoot,
    sessionRoot: top,
    origin,
    roots: roots.length > 0 ? roots : [top],
    project: findProject(settings, origin, mainRoot),
  }
}

async function getContext($: EngineInterface): Promise<Context> {
  context ??= await loadContext($)
  return context
}

const WINDOWS_MEDIA = 'C:\\Windows\\Media'
const MAC_SOUNDS = '/System/Library/Sounds'
const WINDOWS_FILES: Record<Sound, string> = {
  merge: 'tada.wav',
  deploy: 'Windows Notify System Generic.wav',
  failure: 'Windows Critical Stop.wav',
}
const MAC_FILES: Record<Sound, string> = { merge: 'Glass.aiff', deploy: 'Ping.aiff', failure: 'Basso.aiff' }

/** The platform's own player: `$.audio` plays nothing in a Windows or Linux terminal. */
async function playSound($: EngineInterface, kind: Sound, settings: Settings): Promise<void> {
  if (settings.sounds === false) return
  const configured = settings.sounds[kind]
  if (await $.fs.exists(WINDOWS_MEDIA)) {
    const file = (configured ?? `${WINDOWS_MEDIA}\\${WINDOWS_FILES[kind]}`).split("'").join("''")
    await run($, ['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`])
  } else if (await $.fs.exists(MAC_SOUNDS)) {
    await run($, ['afplay', configured ?? `${MAC_SOUNDS}/${MAC_FILES[kind]}`])
  } else if (configured !== undefined) {
    await run($, ['paplay', configured])
  }
}

async function curlOk($: EngineInterface, url: string): Promise<boolean> {
  return isCurlOk(await run($, ['curl', '-sk', '--max-time', '5', '-w', '\\n%{http_code}', url]))
}

async function fetchOk($: EngineInterface, url: string): Promise<boolean> {
  try {
    return (await $.http.fetch(url)).ok
  } catch {
    return false
  }
}

/** A command check runs on its own clock, in the background; the band shows its last result. */
async function commandCheck($: EngineInterface, key: string, check: Extract<Check, { type: 'command' }>, cwd: string): Promise<CheckState> {
  const now = await $.clock.now()
  const last = commandResults.get(key)
  const isDue = last === undefined || now - last.at >= check.everySeconds * 1000
  if (isDue && !commandsRunning.has(key)) {
    commandsRunning.add(key)
    void (async () => {
      let state: CheckState = 'failed'
      try {
        const r = await $.process.run(check.command, { cwd, timeoutMs: COMMAND_TIMEOUT_MS })
        state = r.exitCode === 0 ? 'ok' : 'failed'
      } catch {
        state = 'failed'
      }
      commandResults.set(key, { at: await $.clock.now(), state })
      commandsRunning.delete(key)
    })()
  }
  return last?.state ?? 'running'
}

/** An environment's or running instance's accounts doc, read on every refresh so an edit shows; `missing` when it cannot be read. */
async function instanceAccounts($: EngineInterface, doc: string): Promise<InstanceAccounts> {
  const text = await readText($, doc)
  return text === undefined ? { kind: 'missing', doc } : { kind: 'listed', doc, text, list: docAccounts(text) }
}

type Gathered = { runs?: GhRun[]; branchRuns?: GhRun[]; containers: Container[]; branch?: string }

async function checkStatuses($: EngineInterface, p: Project, check: Check, got: Gathered, mainRoot: string, sessionRoot: string): Promise<CheckStatus[]> {
  const base = { key: check.label, label: check.label, type: check.type, role: check.type === 'workflow' ? check.role : 'check' } as const
  switch (check.type) {
    case 'workflow': {
      const isDeploy = check.role === 'deploy'
      const main: CheckStatus = {
        ...base,
        ...(got.runs === undefined ? { state: 'unknown' } : workflowFacts(newest(got.runs, check.workflow, check.event), isDeploy)),
      }
      if (!check.onSessionBranch || got.branch === undefined || got.branchRuns === undefined) return [main]
      const own: CheckStatus = {
        ...base,
        key: `${check.label}@${got.branch}`,
        label: `${check.label} ${got.branch}`,
        isSessionBranch: true,
        ...workflowFacts(newest(got.branchRuns, check.workflow), false),
      }
      return [main, own]
    }
    case 'http': {
      const [results, accounts] = await Promise.all([
        Promise.all(check.urls.map(url => fetchOk($, url))),
        check.accounts === undefined ? undefined : instanceAccounts($, repoPath(sessionRoot, check.accounts)),
      ])
      return [{ ...base, state: results.every(Boolean) ? 'ok' : 'failed', ...(accounts !== undefined && { accounts }) }]
    }
    case 'docker': {
      const own = ownContainers(got.containers, check.containerPrefixes)
      const isRunning = own.length > 0
      const [urlOk, accounts] = await Promise.all([
        check.url === undefined || !isRunning ? undefined : curlOk($, check.url),
        check.accounts === undefined || !isRunning ? undefined : instanceAccounts($, repoPath(sessionRoot, check.accounts)),
      ])
      return [{ ...base, ...dockerFacts(own, urlOk), ...(accounts !== undefined && { accounts }) }]
    }
    case 'busy': {
      const count = ownContainers(got.containers, check.containerPrefixes).length
      return count === 0 ? [] : [{ ...base, state: 'busy', detail: String(count) }]
    }
    case 'command':
      return [{ ...base, state: await commandCheck($, check.label, check, mainRoot) }]
  }
}

async function readStatus($: EngineInterface, p: Project, mainRoot: string, sessionRoot: string): Promise<ProjectStatus> {
  const cwd = await $.session.cwd()
  const current = await run($, ['git', 'branch', '--show-current'], cwd)
  const branch = current !== undefined && current !== '' && current !== p.branch ? current : undefined
  const workflows = p.checks.filter(c => c.type === 'workflow')
  const needsDocker = p.checks.some(c => c.type === 'docker' || c.type === 'busy')
  const wantsBranch = branch !== undefined && workflows.some(w => w.type === 'workflow' && w.onSessionBranch)

  const [runsJson, branchJson, ps] = await Promise.all([
    workflows.length > 0
      ? run($, ['gh', 'run', 'list', '--branch', p.branch, '--limit', '50', '--json', GH_RUN_FIELDS], mainRoot)
      : Promise.resolve(undefined),
    wantsBranch ? run($, ['gh', 'run', 'list', '--branch', branch, '--limit', '20', '--json', GH_RUN_FIELDS], cwd) : Promise.resolve(undefined),
    needsDocker ? run($, ['docker', 'ps', '--format', DOCKER_PS_FORMAT]) : Promise.resolve(undefined),
  ])
  const got: Gathered = {
    ...(runsJson !== undefined && { runs: parseRuns(runsJson) }),
    ...(branchJson !== undefined && { branchRuns: parseRuns(branchJson) }),
    containers: parseContainers(ps ?? ''),
    ...(branch !== undefined && { branch }),
  }
  const checks = await Promise.all(p.checks.map(check => checkStatuses($, p, check, got, mainRoot, sessionRoot)))
  return { name: p.name, branch: p.branch, checks: checks.flat(), refreshedAt: await $.clock.now() }
}

/** Once per repository: say that `/session-hub:modinstal` would configure it. */
async function hintSetup($: EngineInterface, origin: string | undefined, t: Texts): Promise<void> {
  if (origin === undefined) return
  const key = `hinted:${origin}`
  if ((await $.store.get(key)) === true) return
  await $.store.set(key, true)
  $.ui.toast(t.setupHint(INSTALL_COMMAND))
}

function refreshProject($: EngineInterface): Promise<void> {
  inFlight ??= (async () => {
    try {
      lastRefresh = await $.clock.now()
      context = await loadContext($)
      const { project, mainRoot, sessionRoot, settings, origin } = context
      await update($, language, () => settings.language)
      if (project === undefined || mainRoot === undefined || sessionRoot === undefined) {
        previous = undefined
        await update($, projectStatus, () => null)
        await showStatus($)
        if (mainRoot !== undefined) await hintSetup($, origin, textsFor(settings.language))
        return
      }
      const status = await readStatus($, project, mainRoot, sessionRoot)
      const news = notices(previous, status, textsFor(settings.language).notice)
      previous = status
      await update($, projectStatus, () => status)
      await showStatus($)
      await openEnvironmentTabs($)
      for (const n of news) {
        $.ui.toast(n.text)
        if (n.sound !== undefined) void playSound($, n.sound, settings)
      }
    } finally {
      inFlight = undefined
    }
  })()
  return inFlight
}

/** Why a write into the main checkout is refused, when the project's settings ask for worktrees. */
async function mainCheckoutDeny($: EngineInterface, path: string): Promise<string | undefined> {
  const { project, mainRoot, settings } = await getContext($)
  if (project?.guards.mainCheckout !== true || mainRoot === undefined) return undefined
  return isInMainCheckout(path, mainRoot) ? textsFor(settings.language).guard.mainCheckoutWrite(path, mainRoot, project.name) : undefined
}

async function listNames($: EngineInterface, folder: string): Promise<string[]> {
  try {
    return (await $.fs.list(folder)).map(entry => entry.name)
  } catch {
    return []
  }
}

/** Why a new migration file is refused: its number is already taken in another worktree or on the remote. */
async function migrationDeny($: EngineInterface, path: string): Promise<string | undefined> {
  const { project, mainRoot, roots, settings } = await getContext($)
  if (project === undefined || mainRoot === undefined || project.guards.migrationDirs.length === 0) return undefined
  const target = migrationTarget(path, roots, project.guards.migrationDirs)
  if (target === undefined || (await $.fs.exists(path))) return undefined

  const fresh = worktreePaths((await run($, ['git', 'worktree', 'list', '--porcelain'], mainRoot)) ?? '')
  const onDisk: Listing[] = await Promise.all(
    (fresh.length > 0 ? fresh : roots).map(async root => ({ where: root, names: await listNames($, `${root}/${target.dir}`) })),
  )
  const remoteRef = `origin/${project.branch}`
  const onRemote = (await run($, ['git', '-C', mainRoot, 'ls-tree', '--name-only', remoteRef, '--', `${target.dir}/`])) ?? ''
  const remote: Listing = { where: remoteRef, names: onRemote.split('\n').map(line => line.split('/').pop() ?? '') }

  const clash = migrationClash(target, [...onDisk, remote])
  if (clash === undefined) return undefined
  const byName = new Map<string, string[]>()
  for (const t of clash.taken) byName.set(t.name, [...(byName.get(t.name) ?? []), t.where.split('/').pop() ?? t.where])
  const where = [...byName].map(([name, places]) => `${name} (${places.slice(0, 2).join(', ')}${places.length > 2 ? ', …' : ''})`)
  return textsFor(settings.language).guard.migrationTaken(
    padNumber(target.number, target.width),
    where.join('; '),
    target.dir,
    padNumber(clash.nextFree, target.width),
  )
}

/** Why a shell command is refused: a git call that commits or switches branches in the main checkout. */
async function gitDeny($: EngineInterface, command: string): Promise<string | undefined> {
  const { project, mainRoot, settings } = await getContext($)
  if (project?.guards.mainCheckout !== true || mainRoot === undefined) return undefined
  const cwd = await $.session.cwd()
  const hit = mutatingGitCalls(command, cwd).find(call => isInMainCheckout(call.dir, mainRoot))
  return hit === undefined
    ? undefined
    : textsFor(settings.language).guard.mainCheckoutGit(hit.sub, mainRoot, project.name)
}

/** What `/session-hub:setup` starts from: the repository's facts the settings are made of. */
async function detectProject($: EngineInterface): Promise<string> {
  context = await loadContext($)
  const { mainRoot, origin, roots, settingsFile, project } = context
  if (mainRoot === undefined) return JSON.stringify({ error: 'The session is not in a git repository.' })
  const [defaultBranch, workflows, runs, ps, files] = await Promise.all([
    run($, ['git', '-C', mainRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    run($, ['gh', 'workflow', 'list', '--all', '--json', 'name,path,state'], mainRoot),
    run($, ['gh', 'run', 'list', '--limit', '40', '--json', 'workflowName,event,headBranch,conclusion'], mainRoot),
    run($, ['docker', 'ps', '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}']),
    run($, ['git', '-C', mainRoot, 'ls-files']),
  ])
  return JSON.stringify(
    detectionFacts({
      mainRoot,
      origin,
      worktreeCount: roots.length,
      defaultBranch,
      workflowsJson: workflows,
      runsJson: runs,
      dockerPs: ps,
      trackedFiles: files,
      settingsFile,
      existing: project,
    }),
    null,
    2,
  )
}

/** Writes one project into the settings file, after the person confirmed it. */
async function saveProject($: EngineInterface, input: unknown): Promise<string> {
  const fields = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const raw = fields.project
  const parsed = parseProject(raw, 'project')
  if (typeof parsed === 'string') return `Not saved: ${parsed}`
  const chosen = parseLanguage(fields.language)
  if (fields.language !== undefined && chosen === undefined) return 'Not saved: language must be "en" or "pl".'
  const file = await settingsPath($)
  if (file === undefined) return 'Not saved: no home folder (USERPROFILE/HOME) and no SESSION_HUB_SETTINGS.'
  await $.fs.write(file, withProject(await readText($, file), raw, chosen))
  context = undefined
  previous = undefined
  void refreshProject($)
  const left = parsed.problems.length > 0 ? ` Left out: ${parsed.problems.join('; ')}.` : ''
  const spoken = chosen === undefined ? '' : ` Interface language: ${chosen}.`
  return `Saved project ${parsed.project.name} (${parsed.project.checks.length} checks) to ${file}.${spoken}${left} The band above the prompt refreshes within a minute; ask the person to run /reload-plugins.`
}

/** From the module's `session.start`: the setup tools, and polling of the project's checks. */
export async function startProject($: EngineInterface): Promise<void> {
  await $.tool.register({
    name: 'project_detect',
    description:
      'session-hub: facts about the repository the session works in, for /session-hub:modinstal and /session-hub:setup: origin, default branch, GitHub Actions workflows and their recent runs, running docker containers grouped by compose project, folders of numbered migration files, worktree use, where the settings file is and the project entry it already holds. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: true,
  })
  await $.tool.register({
    name: 'project_save',
    description:
      "session-hub: writes one project entry into session-hub's settings file (outside the repository), replacing an entry of the same name, and optionally the interface's language. Call only after the person confirmed the proposal. `project` follows settings.example.json: name, match {remote|path}, branch, checks [{type: workflow|http|docker|busy|command, label, ...}], guards {mainCheckout, migrationDirs}.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'object', description: 'The project entry, as in settings.example.json.' },
        language: { type: 'string', enum: ['en', 'pl'], description: "The interface's language (pane, band, notifications), for all projects." },
      },
      required: ['project'],
    },
    isDeferred: true,
  })
  $.clock.every(REFRESH_MS, () => void refreshProject($))
  $.clock.after(1_000, () => void refreshProject($))
}

/** From the module's `turn.complete` of the main loop: refresh unless a refresh ran moments ago. */
export async function afterTurn($: EngineInterface): Promise<void> {
  if ((await $.clock.now()) - lastRefresh > MIN_GAP_MS) $.clock.after(100, () => void refreshProject($))
}

const field = (input: unknown, key: string): string | undefined => {
  if (input === null || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

const MARK: Record<CheckState, { mark: string; color: string }> = {
  ok: { mark: '✓', color: 'success' },
  failed: { mark: '✗', color: 'error' },
  running: { mark: '…', color: 'warning' },
  skipped: { mark: '–', color: 'inactive' },
  unknown: { mark: '?', color: 'inactive' },
  busy: { mark: '●', color: 'warning' },
}

export const registerProject = (on: On): void => {
  on('tool.call', { tool: DETECT_TOOL }, async $ => ({ result: await detectProject($) }))

  on('tool.call', { tool: SAVE_TOOL }, async ($, e) => ({ result: await saveProject($, e) }))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const path = field(e, 'file_path') ?? field(e, 'notebook_path')
    const command = field(e, 'command')
    let deny: string | undefined
    if ((tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') && path !== undefined) {
      deny = await mainCheckoutDeny($, path)
      if (deny === undefined && tool === 'Write') deny = await migrationDeny($, path)
    } else if ((tool === 'Bash' || tool === 'PowerShell') && command !== undefined) {
      deny = await gitDeny($, command)
    }
    return deny === undefined ? next(e) : { deny }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, isRunning, isErrored, output } = e.props
    if (isRunning || (tool !== 'Bash' && tool !== 'PowerShell')) return next(e)
    if (!(context?.settings ?? DEFAULT_SETTINGS).cow) return next(e)
    const line = cowSays(field(input, 'command') ?? '', isErrored, outputText(output))
    if (line === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const row = await next(e)
    return (
      <Box flexDirection="column">
        {row}
        <Text color={line.isRed ? 'error' : 'success'}>{cow(line.say).join('\n')}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, projectStatus)
    if (e.props.hasSurvey || s === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const t = textsFor(await read($, language)).band
    const { remote, local } = bandGroups(s.checks)
    const checkCell = (c: CheckStatus) =>
      c.state === 'busy' ? (
        <Text color="warning">
          {c.label} {c.detail}
          <Text dimColor> ({t.handsOff})</Text>
        </Text>
      ) : (
        <Text dimColor={c.state === 'skipped'}>
          {c.label} <Text color={MARK[c.state].color}>{MARK[c.state].mark}</Text>
          {c.detail !== undefined && c.detail !== '' && <Text dimColor> {c.detail}</Text>}
        </Text>
      )
    return (
      <Box>
        <Text wrap="truncate-end">
          <Text bold color="claude">
            {s.name}
          </Text>
          {remote.map(c => (
            <Text>
              <Text dimColor> · </Text>
              {checkCell(c)}
            </Text>
          ))}
          {local.length > 0 && <Text dimColor> | {t.local}: </Text>}
          {local.map((c, i) => (
            <Text>
              {i > 0 && <Text dimColor>, </Text>}
              {checkCell(c)}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })
}
