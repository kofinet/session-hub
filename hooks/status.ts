import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Account, Process, ProjectStatus } from '../types'
import { distinctLogins, sessionOnlyAccounts } from './extract'
import { DEFAULT_LANGUAGE, textsFor } from './i18n'

// Change a tag when its type's fields change (Snapshot; ProjectStatus or CheckStatus): a value an older version stored
// outlives a reload. register.tsx writes the snapshot, project.tsx the project; each file spells its own atoms.
export const SNAPSHOT_SHAPE = 'snapshot-4'
export const PROJECT_SHAPE = 'project-5'
const snapshot = atom({ plugin: 'session-hub', key: 'snapshot' } as const, null, { shape: SNAPSHOT_SHAPE })
const projectStatus = atom({ plugin: 'session-hub', key: 'project' } as const, null, { shape: PROJECT_SHAPE })
/** project.tsx writes it from the settings; the pane, the band and the status line speak it */
const language = atom({ plugin: 'session-hub', key: 'language' } as const, DEFAULT_LANGUAGE)

const MAX_SESSION_ACCOUNTS = 12

/**
 * The accounts the hub lists: the session's own (the newest few) that no environment's document already shows; the
 * environments' accounts are in their own tabs. `instances` are the environments with a document.
 */
export const paneAccounts = (status: ProjectStatus | null, session: readonly Account[]) => {
  const instances = (status?.checks ?? []).flatMap(c => (c.accounts === undefined ? [] : [{ label: c.label, accounts: c.accounts }]))
  const listed = distinctLogins(instances.flatMap(i => (i.accounts.kind === 'listed' ? i.accounts.list : [])))
  const own = sessionOnlyAccounts(session, listed).slice(-MAX_SESSION_ACCOUNTS)
  return { instances, own, count: own.length }
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

/** An environment's tab: `session-hub-env-<label>`, a pane id holding only letters, digits, `_` and `-`. */
export const ENV_PANE_PREFIX = 'session-hub-env-'
const isIdChar = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-'
export const envPane = (label: string): string => `${ENV_PANE_PREFIX}${[...label].map(c => (isIdChar(c) ? c : '_')).join('')}`.slice(0, 64)

/** labels of the environments whose tab this session opened by itself (a tab the person closed stays closed) */
const openedTabs = atom({ plugin: 'session-hub', key: 'openedTabs' } as const, [] as string[])

/**
 * Each environment with a test data document gets its own tab, opened once per session: production and staging as
 * soon as the band reads them, a local stack once it runs.
 */
export async function openEnvironmentTabs($: EngineInterface): Promise<void> {
  const status = await read($, projectStatus)
  const opened = await read($, openedTabs)
  const fresh = (status?.checks ?? []).filter(c => c.accounts?.kind === 'listed' && !opened.includes(c.label)).map(c => c.label)
  if (fresh.length === 0) return
  await update($, openedTabs, list => [...list, ...fresh])
  const t = textsFor(await read($, language)).env
  for (const label of fresh) void $.ui.open({ id: envPane(label), title: t.tabTitle(label) })
}
