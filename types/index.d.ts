export type Url = {
  url: string
  port: number
  /** null until the port was checked */
  isAlive: boolean | null
}

export type ProcessStatus = 'running' | 'started' | 'completed' | 'failed' | 'killed'

/** A process this session (or one of its subagents) started. */
export type Process = {
  /** the background task id (`run_in_background`) */
  id?: string
  command: string
  status: ProcessStatus
  isBackground: boolean
  urls: Url[]
}

/** A login the session handed out; e-mail-only for OAuth/fake-Google logins. */
export type Account = {
  user: string
  password?: string
  /** what the session said about it: the rest of the list item or table row the login leads */
  note?: string
}

export type Worktree = {
  path: string
  branch?: string
  isCurrent: boolean
  isMain: boolean
  /** the branch's upstream (`origin/x`) and how far apart they are; absent when it was never pushed */
  remote?: { upstream: string; ahead: number; behind: number }
}

export type PullRequest = {
  url: string
  repo: string
  number: number
  title?: string
  state?: string
  isDraft?: boolean
  review?: string
  checks?: { pass: number; fail: number; pending: number }
  /** the PR of the session's own branch */
  isOwn?: boolean
}

export type ArtifactItem = {
  label: string
  href: string
  kind: 'artifact' | 'doc' | 'file' | 'link'
  detail?: string
}

export type Snapshot = {
  /** where this session runs: on this machine, or a remote (cloud) session */
  isRemoteSession: boolean
  worktrees: Worktree[]
  prs: PullRequest[]
  processes: Process[]
  /** local addresses the session gave, not tied to one of its processes */
  urls: Url[]
  accounts: Account[]
  artifacts: ArtifactItem[]
  refreshedAt: number
}

export type CheckState = 'ok' | 'failed' | 'running' | 'skipped' | 'unknown' | 'busy'

export type CheckRole = 'ci' | 'deploy' | 'check'

/** One check of the project's settings as the last refresh found it. */
export type CheckStatus = {
  /** unique within the project: the label, plus the branch for a workflow shown on the session's branch */
  key: string
  label: string
  type: 'workflow' | 'http' | 'docker' | 'busy' | 'command'
  role: CheckRole
  state: CheckState
  /** a short fact beside the mark: a commit, a time, a container count */
  detail?: string
  /** a workflow's run id: a new id is a new run */
  runId?: number
  /** a workflow run's title */
  title?: string
  /** a workflow shown on the session's own branch rather than the main one */
  isSessionBranch?: boolean
  /** docker: containers restarting or unhealthy */
  failing?: string[]
  /** http (an environment such as production or staging), and docker while the instance runs: the accounts its document lists */
  accounts?: InstanceAccounts
}

/** An environment's or local instance's accounts, read from the document its check names (`doc`, absolute); `missing` when it could not be read. */
export type InstanceAccounts = { kind: 'listed'; doc: string; /** the whole document, as the pane shows it */ text: string; list: Account[] } | { kind: 'missing'; doc: string }

/** The project the session works in, when the settings know it: its checks, in the settings' order. */
export type ProjectStatus = {
  name: string
  branch: string
  checks: CheckStatus[]
  refreshedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-hub': {
      snapshot: Shaped<Snapshot | null>
      isAutoOpened: boolean
      project: Shaped<ProjectStatus | null>
      /** background tasks' ends the session was notified of outside its messages: task id → status */
      taskEnds: Record<string, string>
      /** the environments' tab sections the person folded or unfolded: `<label>\u0000<title>` → open */
      openSections: Record<string, boolean>
      /** labels of the environments whose tab this session opened by itself */
      openedTabs: string[]
      /** the interface's language, from the settings */
      language: 'en' | 'pl'
    }
  }
}
