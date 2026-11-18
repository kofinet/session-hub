import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Account, Process, ProjectStatus } from '../types'
import { distinctLogins, sessionOnlyAccounts } from './extract'
import { DEFAULT_LANGUAGE, textsFor } from './i18n'

// Change a tag when its type's fields change (Snapshot; ProjectStatus or CheckStatus): a value an older version stored
// outlives a reload. register.tsx writes the snapshot, project.tsx the project; each file spells its own atoms.
export const SNAPSHOT_SHAPE = 'snapshot-4'
export const PROJECT_SHAPE = 'project-4'
const snapshot = atom({ plugin: 'session-hub', key: 'snapshot' } as const, null, { shape: SNAPSHOT_SHAPE })
const projectStatus = atom({ plugin: 'session-hub', key: 'project' } as const, null, { shape: PROJECT_SHAPE })
/** project.tsx writes it from the settings; the pane, the band and the status line speak it */
const language = atom({ plugin: 'session-hub', key: 'language' } as const, DEFAULT_LANGUAGE)

const MAX_SESSION_ACCOUNTS = 12

/**
 * The accounts the pane lists: each running instance's group, then the session's own (the newest few) that no
 * instance's doc already shows. A login two instances' docs both list is counted once.
 */
export const paneAccounts = (status: ProjectStatus | null, session: readonly Account[]) => {
  const instances = (status?.checks ?? []).flatMap(c => (c.accounts === undefined ? [] : [{ label: c.label, accounts: c.accounts }]))
  const listed = distinctLogins(instances.flatMap(i => (i.accounts.kind === 'listed' ? i.accounts.list : [])))
  const own = sessionOnlyAccounts(session, listed).slice(-MAX_SESSION_ACCOUNTS)
  return { instances, own, count: listed.length + own.length }
}

export const isLive = (p: Process) => p.status === 'running' || (p.status === 'started' && p.urls.some(u => u.isAlive))

/**
 * The status line, `hub: 2 proc · 1 PR · 3 accounts`, from what the pane shows: the session's snapshot and the project's
 * running instances. Shown again after each write of either of them.
 */
export async function showStatus($: EngineInterface): Promise<void> {
  const snap = await read($, snapshot)
  const live = (snap?.processes ?? []).filter(isLive).length
  const prs = snap?.prs.length ?? 0
  const accounts = paneAccounts(await read($, projectStatus), snap?.accounts ?? []).count
  const t = textsFor(await read($, language)).statusLine
  const parts = [live > 0 && t.processes(live), prs > 0 && t.prs(prs), accounts > 0 && t.accounts(accounts)].filter(Boolean)
  $.ui.status(parts.length > 0 ? `hub: ${parts.join(' · ')}` : undefined)
}
