import type { CheckState, CheckStatus, ProjectStatus } from '../types'
import { isAbsolute } from './guards'
import type { Texts } from './i18n'

/** A row of `gh run list --json databaseId,workflowName,status,conclusion,headSha,displayTitle,createdAt,event`. */
export type GhRun = {
  databaseId: number
  workflowName: string
  status: string
  conclusion: string
  headSha: string
  displayTitle: string
  createdAt: string
  event: string
}

export const GH_RUN_FIELDS = 'databaseId,workflowName,status,conclusion,headSha,displayTitle,createdAt,event'

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

export const runState = (run: GhRun): CheckState => {
  if (run.status !== 'completed') return 'running'
  if (run.conclusion === 'success') return 'ok'
  return FAILED_CONCLUSIONS.has(run.conclusion) ? 'failed' : 'skipped'
}

/** The newest run of `workflow` among `runs` (gh lists newest first), of `event` when given. */
export const newest = (runs: readonly GhRun[], workflow: string, event?: string): GhRun | undefined =>
  runs.find(r => r.workflowName === workflow && (event === undefined || r.event === event))

export const parseRuns = (json: string | undefined): GhRun[] => {
  if (json === undefined || json === '') return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as GhRun[]) : []
  } catch {
    return []
  }
}

/** What a workflow check shows: the run's state, its commit, and for a deploy its start time. */
export const workflowFacts = (run: GhRun | undefined, showTime: boolean): Pick<CheckStatus, 'state' | 'detail' | 'runId' | 'title'> =>
  run === undefined
    ? { state: 'unknown' }
    : {
        state: runState(run),
        detail: showTime ? hhmm(run.createdAt) : run.headSha.slice(0, 7),
        runId: run.databaseId,
        title: run.displayTitle,
      }

export const hhmm = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5)
}

/** A row of `docker ps --format {{.Names}}\t{{.State}}\t{{.Status}}`. */
export type Container = { name: string; state: string; status: string }

export const DOCKER_PS_FORMAT = '{{.Names}}\t{{.State}}\t{{.Status}}'

export const parseContainers = (text: string): Container[] =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => {
      const [name = '', state = '', status = ''] = line.split('\t')
      return { name, state, status }
    })

const isFailing = (c: Container): boolean => c.state === 'restarting' || c.status.includes('(unhealthy)')

export const ownContainers = (containers: readonly Container[], prefixes: readonly string[]): Container[] =>
  containers.filter(c => prefixes.some(p => c.name.startsWith(p)))

/** A docker stack: its running containers, the failing ones, and its URL when it has one. */
export const dockerFacts = (
  own: readonly Container[],
  urlOk: boolean | undefined,
): Pick<CheckStatus, 'state' | 'detail' | 'failing'> => {
  const failing = own.filter(isFailing).map(c => c.name)
  const running = own.filter(c => c.state === 'running').length
  if (own.length === 0) return { state: 'skipped', detail: 'off', failing }
  const state: CheckState = failing.length > 0 || urlOk === false ? 'failed' : 'ok'
  return { state, detail: String(running), failing }
}

/** The band shows the local instances (docker stacks, busy containers) apart from CI, deploy and production. */
export const bandGroups = (checks: readonly CheckStatus[]): { remote: CheckStatus[]; local: CheckStatus[] } => ({
  remote: checks.filter(c => !isLocal(c)),
  local: checks.filter(isLocal),
})

const isLocal = (c: CheckStatus): boolean => c.type === 'docker' || c.type === 'busy'

/** A path from the settings: relative to the repository's root, or absolute as written. */
export const repoPath = (root: string, path: string): string => (isAbsolute(path) ? path : `${root}/${path}`)

/** `curl -sk -w "\n%{http_code}" <url>` prints the body, then the status code on its own last line. */
export const isCurlOk = (stdout: string | undefined): boolean => {
  if (stdout === undefined) return false
  const code = Number(stdout.trimEnd().split('\n').pop() ?? '')
  return code >= 200 && code < 400
}

export type Sound = 'merge' | 'deploy' | 'failure'
export type Notice = { text: string; sound?: Sound }

const short = (title: string | undefined): string => {
  const t = title ?? ''
  return t.length > 70 ? `${t.slice(0, 69)}…` : t
}

/** Only from a known state: a refresh that could not reach a check leaves `unknown`, and coming back is no news. */
const isKnown = (c: CheckStatus | undefined): c is CheckStatus => c !== undefined && c.state !== 'unknown'

const turned = (before: CheckStatus | undefined, now: CheckStatus, state: CheckState): before is CheckStatus =>
  isKnown(before) && now.state === state && (before.runId !== now.runId || before.state !== state)

const noticeFor = (t: Texts['notice'], project: string, before: CheckStatus | undefined, now: CheckStatus): Notice[] => {
  const out: Notice[] = []
  const what = `${now.label}${now.isSessionBranch === true ? '' : ` (${project})`}`
  if (now.type === 'workflow') {
    if (now.role === 'deploy') {
      const isNewRun = isKnown(before) && before.runId !== undefined && now.runId !== undefined && now.runId !== before.runId
      if (isNewRun && now.state === 'running') out.push({ text: t.deployStarted(what, short(now.title)), sound: 'deploy' })
      if (turned(before, now, 'ok')) out.push({ text: t.deployDone(what) })
      if (turned(before, now, 'failed')) out.push({ text: t.deployFailed(what, short(now.title)), sound: 'failure' })
      return out
    }
    if (turned(before, now, 'failed')) out.push({ text: t.red(what, short(now.title)), sound: 'failure' })
    if (now.role === 'ci' && now.isSessionBranch !== true && turned(before, now, 'ok')) {
      out.push({ text: t.greenMerge(what, short(now.title)), sound: 'merge' })
    }
    return out
  }
  if (now.type === 'docker') {
    const fresh = (now.failing ?? []).filter(name => !(before?.failing ?? []).includes(name))
    if (isKnown(before) && fresh.length > 0) out.push({ text: t.containersFailing(what, fresh.join(', ')) })
    return out
  }
  if (now.type === 'http' || now.type === 'command') {
    if (isKnown(before) && before.state !== 'failed' && now.state === 'failed') {
      out.push({ text: t.down(what), sound: 'failure' })
    }
    if (isKnown(before) && before.state === 'failed' && now.state === 'ok') out.push({ text: t.backUp(what) })
  }
  return out
}

/** What changed between two refreshes and is worth a toast (and maybe a sound). The first refresh says nothing. */
export const notices = (before: ProjectStatus | undefined, now: ProjectStatus, t: Texts['notice']): Notice[] => {
  if (before === undefined || before.name !== now.name) return []
  return now.checks.flatMap(check => noticeFor(t, now.name, before.checks.find(c => c.key === check.key), check))
}
