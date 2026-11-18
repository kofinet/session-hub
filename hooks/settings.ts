import { DEFAULT_LANGUAGE, LANGUAGES, parseLanguage } from './i18n'
import type { Language } from './i18n'

/**
 * session-hub's settings: a JSON file outside any repository (`~/.claude/session-hub/settings.local.json`,
 * or the path in `SESSION_HUB_SETTINGS`). `settings.example.json` in the mod's repository is the documented
 * shape, and `/session-hub:setup` writes it for the project the session works in.
 */

/**
 * What a workflow run means for the notifications: `ci` (red = failure; green on the main branch =
 * a green merge), `deploy` (a new run = a deploy started; its end is announced), `check` (red = failure).
 */
export type Role = 'ci' | 'deploy' | 'check'

export type Check =
  | {
      type: 'workflow'
      label: string
      workflow: string
      role: Role
      /** only runs of this event (`push` keeps PR runs of CI out) */
      event?: string
      /** also show this workflow on the session's own branch, when it is not the main one */
      onSessionBranch: boolean
    }
  | { type: 'http'; label: string; urls: string[]; /** the repository's document of the environment's test accounts */ accounts?: string }
  | { type: 'docker'; label: string; containerPrefixes: string[]; url?: string; /** the repository's document of the instance's accounts */ accounts?: string }
  | { type: 'busy'; label: string; containerPrefixes: string[] }
  | { type: 'command'; label: string; command: string[]; everySeconds: number }

export type Project = {
  name: string
  match: { remote?: string; path?: string }
  branch: string
  checks: Check[]
  guards: { mainCheckout: boolean; migrationDirs: string[] }
}

export type SoundKind = 'merge' | 'deploy' | 'failure'

export type Settings = {
  version: 1
  /** the interface's language (default English) */
  language: Language
  cow: boolean
  /** false: no sounds; else a file per kind, defaulting to the platform's own */
  sounds: false | Partial<Record<SoundKind, string>>
  projects: Project[]
}

export const DEFAULT_SETTINGS: Settings = { version: 1, language: DEFAULT_LANGUAGE, cow: true, sounds: {}, projects: [] }

export const DEFAULT_COMMAND_EVERY_SECONDS = 300

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(s => s !== undefined) : [])
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const ROLES: readonly Role[] = ['ci', 'deploy', 'check']

const parseCheck = (v: unknown, where: string): Check | string => {
  if (!isObject(v)) return `${where} is not an object`
  const label = str(v.label)
  if (label === undefined) return `${where} has no label`
  const at = `${where} (${label})`
  switch (v.type) {
    case 'workflow': {
      const workflow = str(v.workflow)
      if (workflow === undefined) return `${at}: workflow needs the workflow's name`
      const role = ROLES.find(r => r === v.role) ?? 'check'
      const event = str(v.event)
      return { type: 'workflow', label, workflow, role, ...(event !== undefined && { event }), onSessionBranch: bool(v.onSessionBranch, false) }
    }
    case 'http': {
      const urls = strings(v.urls)
      if (urls.length === 0) return `${at}: http needs urls`
      const accounts = str(v.accounts)
      return { type: 'http', label, urls, ...(accounts !== undefined && { accounts }) }
    }
    case 'docker':
    case 'busy': {
      const containerPrefixes = strings(v.containerPrefixes)
      if (containerPrefixes.length === 0) return `${at}: ${v.type} needs containerPrefixes`
      if (v.type === 'busy') return { type: 'busy', label, containerPrefixes }
      const url = str(v.url)
      const accounts = str(v.accounts)
      return { type: 'docker', label, containerPrefixes, ...(url !== undefined && { url }), ...(accounts !== undefined && { accounts }) }
    }
    case 'command': {
      const command = strings(v.command)
      const every = typeof v.everySeconds === 'number' && v.everySeconds >= 60 ? v.everySeconds : DEFAULT_COMMAND_EVERY_SECONDS
      return command.length === 0 ? `${at}: command needs an argument list` : { type: 'command', label, command, everySeconds: every }
    }
    default:
      return `${at}: unknown type ${String(v.type)} (workflow, http, docker, busy, command)`
  }
}

/** One project entry → a project, plus what was left out of it and why; a string when nothing is usable. */
export const parseProject = (v: unknown, where: string): { project: Project; problems: string[] } | string => {
  if (!isObject(v)) return `${where} is not an object`
  const name = str(v.name)
  if (name === undefined) return `${where} has no name`
  const match = isObject(v.match) ? v.match : {}
  const remote = str(match.remote)
  const path = str(match.path)
  if (remote === undefined && path === undefined) return `${name}: match needs a remote or a path`

  const problems: string[] = []
  const checks = (Array.isArray(v.checks) ? v.checks : []).flatMap((c, i) => {
    const parsed = parseCheck(c, `${name}: checks[${i}]`)
    if (typeof parsed === 'string') {
      problems.push(parsed)
      return []
    }
    return [parsed]
  })
  const guards = isObject(v.guards) ? v.guards : {}

  return {
    project: {
      name,
      match: { ...(remote !== undefined && { remote }), ...(path !== undefined && { path }) },
      branch: str(v.branch) ?? 'main',
      checks,
      guards: { mainCheckout: bool(guards.mainCheckout, false), migrationDirs: strings(guards.migrationDirs) },
    },
    problems,
  }
}

/** The settings file's text → settings, plus what was left out and why. A missing file is the defaults. */
export const parseSettings = (text: string | undefined): { settings: Settings; problems: string[] } => {
  if (text === undefined) return { settings: DEFAULT_SETTINGS, problems: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { settings: DEFAULT_SETTINGS, problems: ['settings.local.json is not valid JSON'] }
  }
  if (!isObject(raw)) return { settings: DEFAULT_SETTINGS, problems: ['settings.local.json is not an object'] }

  const problems: string[] = []
  const projects = (Array.isArray(raw.projects) ? raw.projects : []).flatMap((p, i) => {
    const parsed = parseProject(p, `projects[${i}]`)
    if (typeof parsed === 'string') {
      problems.push(parsed)
      return []
    }
    problems.push(...parsed.problems)
    return [parsed.project]
  })

  let sounds: Settings['sounds'] = {}
  if (raw.sounds === false) sounds = false
  else if (isObject(raw.sounds)) {
    sounds = {}
    for (const kind of ['merge', 'deploy', 'failure'] as const) {
      const file = str(raw.sounds[kind])
      if (file !== undefined) sounds[kind] = file
    }
  }

  const language = parseLanguage(raw.language)
  if (raw.language !== undefined && language === undefined) problems.push(`language must be one of ${LANGUAGES.join(', ')}`)

  return { settings: { version: 1, language: language ?? DEFAULT_LANGUAGE, cow: bool(raw.cow, true), sounds, projects }, problems }
}

const norm = (p: string): string => p.split('\\').join('/').toLowerCase()

/** The project a checkout belongs to: its `origin` URL contains `match.remote`, or its main root is under `match.path`. */
export const findProject = (settings: Settings, origin: string | undefined, mainRoot: string): Project | undefined =>
  settings.projects.find(p => {
    const byRemote = p.match.remote !== undefined && origin !== undefined && norm(origin).includes(norm(p.match.remote))
    const root = norm(mainRoot)
    const byPath = p.match.path !== undefined && (root === norm(p.match.path) || root.startsWith(`${norm(p.match.path)}/`))
    return byRemote || byPath
  })

/**
 * The settings file's JSON with `project` put in (an entry of the same name replaced, else added) and, when given,
 * the interface's `language`; the rest of the file kept as it was.
 */
export const withProject = (text: string | undefined, project: unknown, language?: Language): string => {
  let raw: Json = { version: 1, cow: true, sounds: {}, projects: [] }
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isObject(parsed)) raw = parsed
    } catch {
      // an unreadable file is replaced by a fresh one holding this project
    }
  }
  const name = isObject(project) ? str(project.name) : undefined
  const others = (Array.isArray(raw.projects) ? raw.projects : []).filter(p => !(isObject(p) && str(p.name) === name))
  return `${JSON.stringify({ ...raw, ...(language !== undefined && { language }), projects: [...others, project] }, null, 2)}\n`
}
