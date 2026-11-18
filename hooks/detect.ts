import { migrationNumber } from './guards'
import type { Project } from './settings'

export type DetectionInput = {
  mainRoot: string
  origin?: string
  worktreeCount: number
  /** `git symbolic-ref --short refs/remotes/origin/HEAD`: `origin/main` */
  defaultBranch?: string
  /** `gh workflow list --all --json name,path,state` */
  workflowsJson?: string
  /** `gh run list --json workflowName,event,headBranch,conclusion` */
  runsJson?: string
  /** `docker ps --format {{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}` */
  dockerPs?: string
  /** `git ls-files` */
  trackedFiles?: string
  settingsFile?: string
  existing?: Project
}

type WorkflowFact = { name: string; path: string; state: string; recentRuns: { event: string; branch: string; conclusion: string }[] }
type DockerGroup = { composeProject: string; containers: string[]; ports: string[] }

const parseArray = (json: string | undefined): Record<string, unknown>[] => {
  if (json === undefined || json === '') return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object') : []
  } catch {
    return []
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

export const workflowFactsOf = (workflowsJson: string | undefined, runsJson: string | undefined): WorkflowFact[] => {
  const runs = parseArray(runsJson)
  return parseArray(workflowsJson).map(w => ({
    name: text(w.name),
    path: text(w.path),
    state: text(w.state),
    recentRuns: runs
      .filter(r => text(r.workflowName) === text(w.name))
      .slice(0, 5)
      .map(r => ({ event: text(r.event), branch: text(r.headBranch), conclusion: text(r.conclusion) })),
  }))
}

/** Running containers grouped by their compose project (a container outside compose is its own group). */
export const dockerGroups = (dockerPs: string | undefined): DockerGroup[] => {
  const groups = new Map<string, DockerGroup>()
  for (const line of (dockerPs ?? '').split('\n')) {
    const [name = '', compose = '', ports = ''] = line.trim().split('\t')
    if (name === '') continue
    const key = compose === '' ? name : compose
    const group = groups.get(key) ?? { composeProject: compose, containers: [], ports: [] }
    group.containers.push(name)
    if (ports !== '') group.ports.push(ports)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** Folders holding at least three numbered files (`054_name.sql`): migration candidates. */
export const numberedFileDirs = (trackedFiles: string | undefined): { dir: string; count: number; highest: number }[] => {
  const dirs = new Map<string, { count: number; highest: number }>()
  for (const path of (trackedFiles ?? '').split('\n')) {
    const slash = path.lastIndexOf('/')
    if (slash < 0) continue
    const n = migrationNumber(path.slice(slash + 1))
    if (n === undefined) continue
    const dir = path.slice(0, slash)
    const known = dirs.get(dir) ?? { count: 0, highest: 0 }
    dirs.set(dir, { count: known.count + 1, highest: Math.max(known.highest, n) })
  }
  return [...dirs]
    .filter(([, d]) => d.count >= 3)
    .map(([dir, d]) => ({ dir, ...d }))
    .sort((a, b) => b.count - a.count)
}

export const detectionFacts = (i: DetectionInput) => ({
  mainRoot: i.mainRoot,
  origin: i.origin ?? null,
  defaultBranch: i.defaultBranch?.startsWith('origin/') ? i.defaultBranch.slice('origin/'.length) : (i.defaultBranch ?? 'main'),
  usesWorktrees: i.worktreeCount > 1,
  worktreeCount: i.worktreeCount,
  workflows: workflowFactsOf(i.workflowsJson, i.runsJson),
  dockerGroups: dockerGroups(i.dockerPs),
  numberedFileDirs: numberedFileDirs(i.trackedFiles),
  settingsFile: i.settingsFile ?? null,
  existingProject: i.existing ?? null,
})
