import type { Account, ArtifactItem, ProcessStatus } from '../types'
import { argsOf, commandName, runText, simpleCommands } from './shell'
import type { Shell, SimpleCommand, Word } from './shell'
import {
  afterSpaces,
  endsWord,
  hasNearly,
  hasWord,
  indexesOf,
  isAsciiLetter,
  isDigit,
  isSpace,
  isWordChar,
  lines,
  runEnd,
  wordStarts,
  words,
} from './scan'

/** The part of a SessionMessage the extractors read. */
export type Msg = {
  role: 'user' | 'assistant'
  text: string
  toolUses: { tool: string; input: Record<string, unknown>; text?: string; result?: unknown; agentId?: string }[]
}

export type FoundUrl = { url: string; port: number }
export type FoundProcess = {
  id?: string
  command: string
  status: ProcessStatus
  isBackground: boolean
  outputFile?: string
  urls: FoundUrl[]
}
/** `ref` is what `gh pr view` takes: a URL or a number. */
export type FoundPr = { ref: string; url?: string; repo?: string; number?: number }

export type Found = {
  processes: FoundProcess[]
  urls: FoundUrl[]
  accounts: Account[]
  prs: FoundPr[]
  /** worktree paths the session created or entered (absolute, or as typed in `git worktree add`) */
  worktreePaths: string[]
  artifacts: ArtifactItem[]
}

const SHELLS = new Set(['Bash', 'PowerShell'])

/** `[\w-]`: a host label, a task id */
const isNameChar = (c: string): boolean => isWordChar(c) || c === '-'
/** `[\w.-]`: a GitHub owner or repository, a path segment */
const isDottedNameChar = (c: string): boolean => isNameChar(c) || c === '.'

// ── local addresses ───────────────────────────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = ['127.0.0.1', '0.0.0.0', '[::1]']
const LOCALHOST = 'localhost'
/** what may follow a local address: a path, the end of a quote, a bracket or punctuation */
const URL_END = '/"\'`<>)]},;.'

const endsUrl = (s: string, i: number): boolean => i >= s.length || isSpace(s.charAt(i)) || URL_END.includes(s.charAt(i))

/** `(label.)*localhost` from `from`: the indexes it may end at, the longest first. */
const localhostEnds = (s: string, from: number): number[] => {
  const run = runEnd(s, from, isDottedNameChar)
  const ends: number[] = []
  for (let end = run; end >= from + LOCALHOST.length; end--) {
    if (s.slice(end - LOCALHOST.length, end).toLowerCase() !== LOCALHOST) continue
    const subdomains = s.slice(from, end - LOCALHOST.length)
    const isHost =
      subdomains === '' || (subdomains.endsWith('.') && subdomains.slice(0, -1).split('.').every(l => l !== '' && [...l].every(isNameChar)))
    if (isHost) ends.push(end)
  }
  return ends
}

/** After a host: `:port` (2 to 5 digits) or nothing, then the end of the address. */
const portAfter = (s: string, hostEnd: number): { end: number; port?: number } | undefined => {
  if (s.charAt(hostEnd) === ':') {
    const digitsEnd = runEnd(s, hostEnd + 1, isDigit)
    const length = digitsEnd - hostEnd - 1
    if (length >= 2 && length <= 5 && endsUrl(s, digitsEnd)) return { end: digitsEnd, port: Number(s.slice(hostEnd + 1, digitsEnd)) }
  }
  return endsUrl(s, hostEnd) ? { end: hostEnd } : undefined
}

/** `http(s)://` at `i` as the start of a word: the index after it, or undefined. */
const afterScheme = (s: string, i: number): number | undefined => {
  if (i > 0 && isWordChar(s.charAt(i - 1))) return undefined
  if (s.slice(i, i + 7).toLowerCase() === 'http://') return i + 7
  if (s.slice(i, i + 8).toLowerCase() === 'https://') return i + 8
  return undefined
}

/** A local address at `i`: its host as written, its port, and where it ends. */
const localUrlAt = (s: string, i: number): { host: string; port?: number; end: number } | undefined => {
  const hostStart = afterScheme(s, i)
  if (hostStart === undefined) return undefined
  const hostEnds = [
    ...localhostEnds(s, hostStart),
    ...LOOPBACK_HOSTS.filter(h => s.startsWith(h, hostStart)).map(h => hostStart + h.length),
  ]
  for (const hostEnd of hostEnds) {
    const after = portAfter(s, hostEnd)
    if (after !== undefined) return { host: s.slice(hostStart, hostEnd), ...after }
  }
  return undefined
}

export const fileHref = (path: string): string => {
  const slashed = path.split('\\').join('/')
  const withRoot = isAsciiLetter(slashed.charAt(0)) && slashed.startsWith(':/', 1) ? `/${slashed}` : slashed
  return `file://${encodeURI(withRoot)}`
}

const basename = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

const withoutMarkdown = (line: string): string => line.split('**').join('').split('`').join('')

/** A value without Markdown marks and the punctuation that closes the sentence after it. */
const clean = (s: string): string => {
  const plain = withoutMarkdown(s)
  return plain.slice(0, runEndBack(plain, c => '.,;:)'.includes(c)))
}

/** The index where the run of characters at the end of `s` that all pass `test` starts. */
const runEndBack = (s: string, test: (c: string) => boolean): number => {
  let i = s.length
  while (i > 0 && test(s.charAt(i - 1))) i--
  return i
}

const PLACEHOLDER_WORDS = new Set(['password', 'hasło', 'haslo', 'pass', 'user', 'username', 'login', 'null', 'undefined', 'none', 'true', 'false', '...'])

/** `<user>`, `***`, `$VAR`, `{x}`, `fn(x)`, `process.env.X`, `your-pass`, `xxx`, a field's own name… */
const isPlaceholder = (s: string): boolean => {
  const lower = s.toLowerCase()
  return (
    (s.length >= 2 && s.startsWith('<') && s.endsWith('>')) ||
    [...s].every(c => c === '*') ||
    s.startsWith('$') ||
    s.startsWith('{') ||
    s.includes('(') ||
    lower.startsWith('process.env') ||
    lower.startsWith('your-') ||
    lower.startsWith('your_') ||
    (lower.length >= 3 && [...lower].every(c => c === 'x')) ||
    PLACEHOLDER_WORDS.has(lower)
  )
}

const isValue = (s: string | undefined): s is string => s !== undefined && s.length > 0 && s.length <= 64 && !isPlaceholder(s)

/** Local addresses in a text (`localhost`, `*.localhost`, loopback), keyed by origin. */
export const localUrls = (text: string): FoundUrl[] => {
  const found = new Map<string, FoundUrl>()
  let i = 0
  while (i < text.length) {
    const at = localUrlAt(text, i)
    if (at === undefined) {
      i++
      continue
    }
    const scheme = text.slice(i, i + 5).toLowerCase() === 'https' ? 'https' : 'http'
    const raw = at.host.toLowerCase()
    const host = raw === '0.0.0.0' || raw === '[::1]' ? 'localhost' : raw
    const port = at.port ?? (scheme === 'https' ? 443 : 80)
    const url = `${scheme}://${host}${at.port !== undefined ? `:${port}` : ''}`
    found.set(url, { url, port })
    i = at.end
  }
  return [...found.values()]
}

// ── accounts ──────────────────────────────────────────────────────────────────────────────────────────

const USER_KEYS = ['username', 'user', 'login', 'e-mail', 'email', 'użytkownik', 'uzytkownik']
const PASSWORD_KEYS = ['password', 'passwd', 'pass', 'pwd', 'hasło', 'haslo']
const USER_COLUMNS = new Set(['user', 'username', 'login', 'email', 'e-mail', 'użytkownik', 'uzytkownik', 'konto'])
const PASSWORD_COLUMNS = new Set(['password', 'pass', 'hasło', 'haslo'])
/** where a `key: value` value ends */
const VALUE_STOP = '"\',;|'
const MAX_PAIR_PART = 40

const isQuote = (c: string): boolean => c === '"' || c === "'"

/** After a key: an optional quote, `:` or `=`, an optional quote, then the value up to a space, quote, `,`, `;` or `|`. */
const valueAfterKey = (s: string, i: number): string | undefined => {
  let j = runEnd(s, isQuote(s.charAt(i)) ? i + 1 : i, isSpace)
  if (s.charAt(j) !== ':' && s.charAt(j) !== '=') return undefined
  j = runEnd(s, j + 1, isSpace)
  if (isQuote(s.charAt(j))) j++
  const end = runEnd(s, j, c => !isSpace(c) && !VALUE_STOP.includes(c))
  return end > j ? s.slice(j, end) : undefined
}

/** The first `key: value` in a line for any of the keys, a key not glued to a letter before it (`superuser` is no `user`). */
const keyedValue = (line: string, keys: readonly string[]): string | undefined => {
  for (let p = 0; p < line.length; p++) {
    if (p > 0 && isAsciiLetter(line.charAt(p - 1))) continue
    for (const key of keys) {
      if (line.slice(p, p + key.length).toLowerCase() !== key) continue
      const value = valueAfterKey(line, p + key.length)
      if (value !== undefined) return value
    }
  }
  return undefined
}

const CREDENTIAL_WORDS = ['login', 'logowan', 'credential', 'account', 'konto', 'zaloguj', 'użytkownik', 'uzytkownik', 'hasło', 'haslo', 'password']

/** A line about logging in or accounts, where `user / password` is a login. */
const isCredentialLine = (line: string): boolean => {
  const lower = line.toLowerCase()
  return (
    CREDENTIAL_WORDS.some(w => lower.includes(w)) ||
    hasNearly(lower, 'sign', 'in') ||
    hasNearly(lower, 'test', 'user') ||
    wordStarts(lower, 'user').length > 0 ||
    wordStarts(lower, 'admin').length > 0
  )
}

const isPairUserChar = (c: string): boolean => isWordChar(c) || '.@+-'.includes(c)

/** The first `user / password` in a line: 2–40 characters, ` / `, then 3–40 characters without a space or `/`. */
const slashPair = (line: string): { user: string; password: string } | undefined => {
  for (let p = 0; p < line.length; p++) {
    const userEnd = runEnd(line, p, isPairUserChar)
    if (userEnd - p < 2 || userEnd - p > MAX_PAIR_PART) continue
    const slash = afterSpaces(line, userEnd)
    if (slash === undefined || line.charAt(slash) !== '/') continue
    const from = afterSpaces(line, slash + 1)
    if (from === undefined) continue
    const end = runEnd(line, from, c => !isSpace(c) && c !== '/')
    if (end - from < 3) continue
    return { user: line.slice(p, userEnd), password: line.slice(from, Math.min(end, from + MAX_PAIR_PART)) }
  }
  return undefined
}

const tableCells = (line: string): string[] =>
  line
    .split('|')
    .slice(1, -1)
    .map(c => c.trim())

/** `|---|:--:|` */
const isTableRule = (cells: readonly string[]): boolean => {
  const joined = cells.join('')
  return joined !== '' && [...joined].every(c => isSpace(c) || c === ':' || c === '-')
}

/** Test credentials mentioned in a block of text: `user / pass`, `user: x` + `password: y`, md tables. */
export const findAccounts = (text: string): Account[] => accountsByLine(text).map(m => m.account)

/** The same, each with the index of the line it was found on. */
const accountsByLine = (text: string): { account: Account; line: number }[] => {
  const found: { account: Account; line: number }[] = []
  const plain = lines(text).map(withoutMarkdown)
  let tableCols: { user: number; pass: number } | null = null

  plain.forEach((line, i) => {
    // markdown tables: | user | password |
    if (line.trim().startsWith('|')) {
      const cells = tableCells(line)
      const user = cells.findIndex(c => USER_COLUMNS.has(c.toLowerCase()))
      const pass = cells.findIndex(c => PASSWORD_COLUMNS.has(c.toLowerCase()))
      if (user >= 0 && pass >= 0) {
        tableCols = { user, pass }
        return
      }
      if (tableCols && !isTableRule(cells)) {
        const u = cells[tableCols.user]
        const p = cells[tableCols.pass]
        const cols = tableCols
        const note = cells.filter((c, j) => j !== cols.user && j !== cols.pass && c !== '').join(' · ')
        if (isValue(u)) found.push({ account: { user: u, ...(isValue(p) && { password: p }), ...(note !== '' && { note }) }, line: i })
        return
      }
      return
    }
    tableCols = null

    const userValue = keyedValue(line, USER_KEYS)
    if (userValue !== undefined) {
      const passwordValue = [line, plain[i + 1] ?? '', plain[i + 2] ?? ''].map(l => keyedValue(l, PASSWORD_KEYS)).find(v => v !== undefined)
      const user = clean(userValue)
      const password = passwordValue === undefined ? undefined : clean(passwordValue)
      if (isValue(user) && isValue(password)) {
        found.push({ account: { user, password }, line: i })
        return
      }
    }

    if (isCredentialLine(line)) {
      const pair = slashPair(line)
      // `docs / https://…` is a link, not a password
      if (pair && !pair.password.startsWith('http:') && !pair.password.startsWith('https:')) {
        const user = clean(pair.user)
        const password = clean(pair.password)
        if (isValue(user) && isValue(password)) found.push({ account: { user, password }, line: i })
      }
    }
  })

  return found
}

const TEST_DOMAINS = ['example.com', 'example.org', 'example.net']
const TEST_DOMAIN_ENDINGS = ['.local', '.localhost', '.test', '.example', '.invalid']
const MAX_RANGE = 10
const NOTE_LEAD = ':—–-,( '
const MAX_NOTE = 160

/** An address on a reserved or local domain is a test login wherever the session gives it. */
const isTestEmail = (email: string): boolean => {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  return TEST_DOMAINS.includes(domain) || TEST_DOMAIN_ENDINGS.some(ending => domain.endsWith(ending))
}

const isNotLoginEmail = (email: string): boolean => {
  const lower = email.toLowerCase()
  return lower.includes('noreply') || lower.includes('no-reply') || lower.endsWith('@anthropic.com')
}

const LOGIN_WORDS = ['zaloguj', 'logowa', 'login', 'log in', 'konto', 'konta', 'account', 'credential']

/** A line about logging in, where any address is a login. */
const isLoginLine = (line: string): boolean => {
  const lower = line.toLowerCase()
  return LOGIN_WORDS.some(w => lower.includes(w)) || hasNearly(lower, 'sign', 'in') || hasWord(lower, 'jako')
}

const isEmailLocalChar = (c: string): boolean => isWordChar(c) || c === '.' || c === '+' || c === '-'

/**
 * The domain of an address from `i`: dotted labels, the last one taken up to the end of the letters it starts with
 * (at least two). Where it ends, or undefined.
 */
const emailDomainEnd = (s: string, i: number): number | undefined => {
  let labelEnd = runEnd(s, i, isNameChar)
  if (labelEnd === i) return undefined
  let end: number | undefined
  while (s.charAt(labelEnd) === '.') {
    const labelStart = labelEnd + 1
    const next = runEnd(s, labelStart, isNameChar)
    if (next === labelStart) break
    const letters = runEnd(s, labelStart, isAsciiLetter)
    if (letters - labelStart >= 2) end = letters
    labelEnd = next
  }
  return end
}

/** The e-mail addresses in a text, in order. */
const emailAddresses = (text: string): string[] => {
  const found: string[] = []
  let from = 0
  for (const at of indexesOf(text, '@')) {
    if (at < from) continue
    let start = at
    while (start > from && isEmailLocalChar(text.charAt(start - 1))) start--
    if (start === at) continue
    const end = emailDomainEnd(text, at + 1)
    if (end === undefined) continue
    found.push(text.slice(start, end))
    from = end
  }
  return found
}

/**
 * `klient1..3@example.com` → `klient1@`, `klient2@`, `klient3@example.com` (at most 10).
 * Any other `..` makes no address at all.
 */
export const expandEmail = (email: string): string[] => {
  const at = email.lastIndexOf('@')
  const local = email.slice(0, at)
  const domain = email.slice(at)
  const dots = local.indexOf('..')
  if (dots < 0) return [email]

  const head = local.slice(0, dots)
  const last = local.slice(dots + 2)
  let digitsAt = head.length
  while (digitsAt > 0 && isDigit(head.charAt(digitsAt - 1))) digitsAt--
  const prefix = head.slice(0, digitsAt)
  const first = head.slice(digitsAt)
  if (first === '' || last === '' || ![...last].every(isDigit)) return []

  const from = Number(first)
  const to = Number(last)
  if (to <= from || to - from >= MAX_RANGE) return []
  return Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}${domain}`)
}

const listItemBody = (line: string): string => {
  const trimmed = line.trim()
  if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) return trimmed.slice(2).trim()
  const dot = trimmed.indexOf('. ')
  if (dot > 0 && [...trimmed.slice(0, dot)].every(isDigit)) return trimmed.slice(dot + 2).trim()
  return trimmed
}

/**
 * What a line says about the one address it is about: the other cells of a table row,
 * or the rest of a list item (or line) that the address leads. Prose around an address
 * in the middle of a sentence is no note.
 */
const noteFor = (line: string, email: string): string | undefined => {
  const plain = withoutMarkdown(line)
  const trimmed = plain.trim()
  let note: string
  if (trimmed.startsWith('|')) {
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())
    if (!cells.some(c => c === email)) return undefined
    note = cells.filter(c => c !== email && c !== '').join(' · ')
  } else {
    const body = listItemBody(plain)
    if (!body.startsWith(email)) return undefined
    const rest = body.slice(email.length)
    let start = 0
    while (start < rest.length && NOTE_LEAD.includes(rest.charAt(start))) start++
    note = rest.slice(start).trim()
    if (rest.trimStart().startsWith('(') && note.endsWith(')')) note = note.slice(0, -1).trim()
  }
  if (note === '') return undefined
  return note.length > MAX_NOTE ? `${note.slice(0, MAX_NOTE - 1)}…` : note
}

/**
 * E-mail logins without a password (OAuth / fake-Google): an address on a line about logging in,
 * or any address on a test domain. A range shortcut is listed one address at a time, and each
 * carries what the line says about it.
 */
export const findLoginEmails = (text: string): Account[] =>
  lines(text).flatMap(line => {
    const aboutLogin = isLoginLine(line)
    return emailAddresses(line).flatMap(address => {
      const note = noteFor(line, address)
      return expandEmail(address)
        .filter(email => !isNotLoginEmail(email) && (aboutLogin || isTestEmail(email)))
        .map((user): Account => (note === undefined ? { user } : { user, note }))
    })
  })

/** Logins are told apart regardless of capitals: `Admin@shop.local` is `admin@shop.local`. */
const loginKey = (user: string): string => user.toLowerCase()

/**
 * The accounts a document lists, as a local instance's accounts doc: each login once, in the order
 * the document first mentions it, with a password and a note when any mention has one.
 */
export const docAccounts = (text: string): Account[] => {
  const docLines = text.split('\n')
  const mentions = [
    ...accountsByLine(text),
    ...docLines.flatMap((l, line) => findLoginEmails(l).map(account => ({ account, line }))),
  ].sort((a, b) => a.line - b.line)
  const byLogin = new Map<string, Account>()
  for (const { account: a } of mentions) {
    const known = byLogin.get(loginKey(a.user))
    const password = known?.password ?? a.password
    const note = known?.note ?? a.note
    byLogin.set(loginKey(a.user), { user: known?.user ?? a.user, ...(password !== undefined && { password }), ...(note !== undefined && { note }) })
  }
  return [...byLogin.values()]
}

/** Each login once, its first mention kept: one doc can serve several instances. */
export const distinctLogins = (accounts: readonly Account[]): Account[] =>
  accounts.filter((a, i) => accounts.findIndex(b => loginKey(b.user) === loginKey(a.user)) === i)

/**
 * The session's accounts that the running instances' docs do not already show: a login a doc lists
 * is left out unless the session gave it a password the doc does not (the doc may be stale).
 */
export const sessionOnlyAccounts = (session: readonly Account[], listed: readonly Account[]): Account[] =>
  session.filter(
    s => !listed.some(l => loginKey(l.user) === loginKey(s.user) && (s.password === undefined || s.password === l.password)),
  )

// ── commands ──────────────────────────────────────────────────────────────────────────────────────────

const NPM_SCRIPTS = ['dev', 'start', 'preview', 'serve']
/** shells that run a start script given to them: `bash start.sh`, `pwsh -File start.ps1` */
const SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'])

/** `start*.ps1` or `start*.sh`: the project's start scripts. */
const isStartScriptName = (word: string): boolean => {
  const name = basename(word).toLowerCase()
  return name.startsWith('start') && (name.endsWith('.ps1') || name.endsWith('.sh'))
}

/** A simple command that leaves something running: a server, a container, the project's start script. */
const isStartCommand = (c: SimpleCommand): boolean => {
  const name = commandName(c)
  const args = argsOf(c).map(w => w.text.toLowerCase())
  const options = argsOf(c)
    .filter(w => !w.isQuoted)
    .map(w => w.text.toLowerCase())
  switch (name) {
    case 'docker':
      return args[0] === 'run' || (args[0] === 'compose' && options.includes('up'))
    case 'docker-compose':
      return options.includes('up')
    case 'npm': {
      const script = args[0] === 'run' ? args[1] : args[0]
      return script !== undefined && NPM_SCRIPTS.some(n => script === n || script.startsWith(`${n}:`))
    }
    case 'npx':
      return args[0] === 'vite'
    case 'vite':
    case 'uvicorn':
      return true
    case 'dotnet':
      return args[0] === 'run' || args[0] === 'watch'
    case 'node':
      return (args[0] ?? '').includes('server')
    default:
      if (name.startsWith('python') || name === 'py') return options.includes('http.server') || options.includes('uvicorn')
      return isStartScriptName(name) || (SHELL_NAMES.has(name) && options.some(isStartScriptName))
  }
}

const shellOf = (tool: string): Shell => (tool === 'PowerShell' ? 'powershell' : 'bash')

/** Commands that leave something running: servers, containers, the project's start scripts. */
const isStart = (command: string, shell: Shell): boolean => simpleCommands(command, shell).some(isStartCommand)

/** commands that run the project's code, so a `seed` among their words seeds data (a `grep seed` only reads) */
const RUNNERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'tsx', 'ts-node', 'dotnet', 'php', 'rails', 'rake', 'bundle', 'make', 'just', 'docker', 'docker-compose', 'go', 'cargo', 'mvn', 'gradle'])

const hasSeedWord = (words: readonly Word[]): boolean => words.some(w => !w.isQuoted && wordStarts(w.text.toLowerCase(), 'seed').length > 0)

/** A command that seeds data (`npm run db:seed`, `dotnet run -- --seed`, `./seed.sh`): its output may list the accounts it made. */
const isSeed = (command: string, shell: Shell): boolean =>
  simpleCommands(command, shell).some(c => {
    const name = commandName(c)
    const isRunner = RUNNERS.has(name) || name.startsWith('python') || name === 'py' || SHELL_NAMES.has(name)
    return name.startsWith('seed') || (isRunner && hasSeedWord(argsOf(c)))
  })

/** Where the digits of a port flag start at `i`: `--port 80`, `--port=80`, `PORT=80`, `server.port=80`, ` -p 80`. */
const portFlagEnd = (s: string, i: number): number | undefined => {
  if (s.startsWith('--port', i) && (s.charAt(i + 6) === ' ' || s.charAt(i + 6) === '=')) return i + 7
  if (s.startsWith('PORT=', i) && (i === 0 || !isWordChar(s.charAt(i - 1)))) return i + 5
  if (s.startsWith('server.port=', i)) return i + 12
  if (isSpace(s.charAt(i)) && s.startsWith('-p', i + 1)) return afterSpaces(s, i + 3)
  return undefined
}

/** The ports a command names with a port flag (2 to 5 digits), in order. */
const namedPorts = (command: string): number[] => {
  const found: number[] = []
  let i = 0
  while (i < command.length) {
    const from = portFlagEnd(command, i)
    const end = from === undefined ? from : runEnd(command, from, isDigit)
    if (from !== undefined && end !== undefined && end - from >= 2 && end - from <= 5 && endsWord(command, end)) {
      found.push(Number(command.slice(from, end)))
      i = end
    } else i++
  }
  return found
}

const BACKGROUND_ID = 'running in background with ID:'
const OUTPUT_FILE = 'Output is being written to:'
const OUTPUT_EXT = '.output'

/** The background task's id a tool result announces. */
const backgroundId = (out: string): string | undefined => {
  for (const i of indexesOf(out, BACKGROUND_ID)) {
    const from = runEnd(out, i + BACKGROUND_ID.length, isSpace)
    const end = runEnd(out, from, isNameChar)
    if (end > from) return out.slice(from, end)
  }
  return undefined
}

/** The `.output` file a background task writes to. */
const outputFile = (out: string): string | undefined => {
  for (const i of indexesOf(out, OUTPUT_FILE)) {
    const from = runEnd(out, i + OUTPUT_FILE.length, isSpace)
    const pathEnd = runEnd(out, from, c => !isSpace(c))
    for (let ext = out.indexOf(OUTPUT_EXT, from + 1); ext >= 0 && ext + OUTPUT_EXT.length <= pathEnd; ext = out.indexOf(OUTPUT_EXT, ext + 1)) {
      if (endsWord(out, ext + OUTPUT_EXT.length)) return out.slice(from, ext + OUTPUT_EXT.length)
    }
  }
  return undefined
}

/** `<task-id>x</task-id> … <status>y</status>` pairs of task notifications, in order. */
const taskNotifications = (text: string): { id: string; status: string }[] => {
  const found: { id: string; status: string }[] = []
  let from = 0
  for (let i = text.indexOf('<task-id>', from); i >= 0; i = text.indexOf('<task-id>', from)) {
    from = i + 1
    const idStart = i + '<task-id>'.length
    const idEnd = runEnd(text, idStart, isNameChar)
    if (idEnd === idStart || !text.startsWith('</task-id>', idEnd)) continue
    for (const s of indexesOf(text, '<status>').filter(s => s >= idEnd + '</task-id>'.length)) {
      const statusStart = s + '<status>'.length
      const statusEnd = runEnd(text, statusStart, isWordChar)
      if (statusEnd > statusStart && text.startsWith('</status>', statusEnd)) {
        found.push({ id: text.slice(idStart, idEnd), status: text.slice(statusStart, statusEnd) })
        from = statusEnd + '</status>'.length
        break
      }
    }
  }
  return found
}

const GITHUB = 'github.com/'
const GITHUB_URL = `https://${GITHUB}`

/** `<owner>/<repo>` at `i`. */
const repoAt = (s: string, i: number): { repo: string; end: number } | undefined => {
  const ownerEnd = runEnd(s, i, isDottedNameChar)
  if (ownerEnd === i || s.charAt(ownerEnd) !== '/') return undefined
  const end = runEnd(s, ownerEnd + 1, isDottedNameChar)
  return end > ownerEnd + 1 ? { repo: s.slice(i, end), end } : undefined
}

/** `<owner>/<repo>/pull/<n>` at `i`. */
const pullAt = (s: string, i: number): { repo: string; number: number; end: number } | undefined => {
  const repo = repoAt(s, i)
  if (repo === undefined || !s.startsWith('/pull/', repo.end)) return undefined
  const from = repo.end + '/pull/'.length
  const end = runEnd(s, from, isDigit)
  return end > from ? { repo: repo.repo, number: Number(s.slice(from, end)), end } : undefined
}

/** `https://github.com/<owner>/<repo>/pull/<n>` links in a text, in order. */
const pullUrls = (text: string): { url: string; repo: string; number: number }[] => {
  const found: { url: string; repo: string; number: number }[] = []
  let from = 0
  for (const i of indexesOf(text, GITHUB_URL)) {
    if (i < from) continue
    const pull = pullAt(text, i + GITHUB_URL.length)
    if (pull === undefined) continue
    found.push({ url: text.slice(i, pull.end), repo: pull.repo, number: pull.number })
    from = pull.end
  }
  return found
}

/** `owner/repo` of a pull request's URL; `''` when it is none. */
export const pullRepo = (url: string): string => {
  for (const i of indexesOf(url, GITHUB)) {
    const repo = repoAt(url, i + GITHUB.length)
    if (repo !== undefined && url.startsWith('/pull', repo.end)) return repo.repo
  }
  return ''
}

/** gh calls through which the session made or changed a PR (a mere `gh pr list`/`view` does not count) */
const PR_WRITES = ['create', 'merge', 'edit', 'ready', 'comment', 'review', 'close', 'reopen']

/** `12` or `#12` */
const prNumber = (word: Word | undefined): number | undefined => {
  if (word === undefined || word.isQuoted) return undefined
  const digits = word.text.startsWith('#') ? word.text.slice(1) : word.text
  return digits !== '' && [...digits].every(isDigit) ? Number(digits) : undefined
}

/**
 * `gh pr <verb> [#n]` calls that change a PR: the verb, the number named right after it (not for `create`), and the
 * call's words (a PR's URL may be one of them).
 */
const prWrites = (command: string, shell: Shell): { verb: string; number?: number; text: string }[] =>
  simpleCommands(command, shell).flatMap(c => {
    const args = argsOf(c)
    const verb = args[1]?.text
    if (commandName(c) !== 'gh' || args[0]?.text !== 'pr' || verb === undefined || !PR_WRITES.includes(verb)) return []
    const number = verb === 'create' ? undefined : prNumber(args[2])
    return [{ verb, ...(number !== undefined && { number }), text: c.words.map(w => w.text).join(' ') }]
  })

// ── artifacts ─────────────────────────────────────────────────────────────────────────────────────────

const CLAUDE_AI = 'https://claude.ai/'

/** `https://claude.ai/[code/]artifact/<id>` links in a text, in order. */
const claudeUrls = (text: string): string[] => {
  const found: string[] = []
  let from = 0
  for (const i of indexesOf(text, CLAUDE_AI)) {
    if (i < from) continue
    const afterHost = i + CLAUDE_AI.length
    const at = text.startsWith('code/artifact/', afterHost) ? afterHost + 5 : afterHost
    if (!text.startsWith('artifact/', at)) continue
    const idStart = at + 'artifact/'.length
    const end = runEnd(text, idStart, isNameChar)
    if (end === idStart) continue
    found.push(text.slice(i, end))
    from = end
  }
  return found
}

/** Links to designs, documents and previews on these hosts and paths. */
const DESIGN_PATHS = [
  'figma.com/file',
  'figma.com/design',
  'figma.com/board',
  'figma.com/proto',
  'canva.com/design',
  'docs.google.com/document/d',
  'docs.google.com/presentation/d',
  'docs.google.com/spreadsheets/d',
  'miro.com/app/board',
  'gamma.app/docs',
]
const PREVIEW_HOSTS = ['.netlify.app', '.vercel.app']
const EXCALIDRAW = 'excalidraw.com/'
/** what ends a link in prose */
const LINK_END = '"\'`<>)]'

/** After `https://`: the end of a design link's host and path, or undefined. */
const designHeadEnd = (s: string, i: number): number | undefined => {
  for (const at of s.startsWith('www.', i) ? [i + 4, i] : [i]) {
    const path = DESIGN_PATHS.find(p => s.startsWith(p, at))
    if (path !== undefined) return at + path.length
    if (s.startsWith(EXCALIDRAW, at)) {
      const from = at + EXCALIDRAW.length + (s.charAt(at + EXCALIDRAW.length) === '#' ? 1 : 0)
      const end = runEnd(s, from, c => isNameChar(c) || c === '=' || c === ',')
      if (end > from) return end
    }
    const nameEnd = runEnd(s, at, isNameChar)
    const preview = nameEnd > at ? PREVIEW_HOSTS.find(h => s.startsWith(h, nameEnd)) : undefined
    if (preview !== undefined) return nameEnd + preview.length
  }
  return undefined
}

/** Design links in a text (Figma, Canva, Excalidraw, Google Docs, Miro, Gamma, Netlify and Vercel previews), in order. */
const designLinks = (text: string): string[] => {
  const found: string[] = []
  let from = 0
  for (const i of indexesOf(text, 'https://')) {
    if (i < from) continue
    const head = designHeadEnd(text, i + 'https://'.length)
    if (head === undefined) continue
    const end = runEnd(text, head, c => !isSpace(c) && !LINK_END.includes(c))
    found.push(text.slice(i, end))
    from = end
  }
  return found
}

const DOC_EXTENSIONS = ['md', 'mdx', 'html', 'htm', 'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'svg', 'png', 'drawio', 'excalidraw', 'mmd', 'puml']
const CLAUDE_FILES = ['claude.md', 'memory.md', 'agents.md']

const isDocument = (path: string): boolean => DOC_EXTENSIONS.some(ext => path.toLowerCase().endsWith(`.${ext}`))

/** Claude's own files and dependencies are no artifacts of the session. */
const isNotArtifact = (path: string): boolean => {
  const slashed = path.split('\\').join('/').toLowerCase()
  return slashed.includes('/.claude/') || slashed.includes('/node_modules/') || CLAUDE_FILES.includes(basename(slashed))
}

// ── paths ─────────────────────────────────────────────────────────────────────────────────────────────

/** what ends a Windows path in prose */
const PATH_STOP = '"\'`<>|*?'

/** `C:\…` or `C:/…` at `i`: where it ends. */
const windowsPathEnd = (s: string, i: number): number | undefined => {
  const slash = s.charAt(i + 2)
  if (!isAsciiLetter(s.charAt(i)) || s.charAt(i + 1) !== ':' || (slash !== '\\' && slash !== '/')) return undefined
  const end = runEnd(s, i + 3, c => !isSpace(c) && !PATH_STOP.includes(c))
  return end > i + 3 ? end : undefined
}

/** `/a/b…` at `i`, at least two segments, not glued to a word or `.` before it: where it ends. */
const posixPathEnd = (s: string, i: number): number | undefined => {
  if (s.charAt(i) !== '/' || (i > 0 && isDottedNameChar(s.charAt(i - 1)))) return undefined
  let end = i
  let segments = 0
  let at = i + 1
  for (;;) {
    const segmentEnd = runEnd(s, at, isDottedNameChar)
    if (segmentEnd === at) break
    segments++
    end = segmentEnd
    if (s.charAt(segmentEnd) !== '/') break
    at = segmentEnd + 1
  }
  return segments >= 2 ? end : undefined
}

/** The absolute paths in a text, Windows or POSIX, in order. */
const absolutePaths = (text: string): string[] => {
  const found: string[] = []
  let i = 0
  while (i < text.length) {
    const end = windowsPathEnd(text, i) ?? posixPathEnd(text, i)
    if (end === undefined) {
      i++
      continue
    }
    found.push(text.slice(i, end))
    i = end
  }
  return found
}

/** options of `git worktree add` that take a value */
const WORKTREE_VALUE_OPTIONS = ['-b', '-B', '--reason']

/** `git worktree add [opts] <path> [commit]` → `<path>` as typed. */
export const worktreeAddPaths = (command: string, shell: Shell = 'bash'): string[] =>
  simpleCommands(command, shell).flatMap(c => {
    const args = argsOf(c).map(w => w.text)
    if (commandName(c) !== 'git' || args[0] !== 'worktree' || args[1] !== 'add') return []
    for (let k = 2; k < args.length; k++) {
      const arg = args[k] ?? ''
      if (WORKTREE_VALUE_OPTIONS.includes(arg)) k++
      else if (!arg.startsWith('-')) return [arg]
    }
    return []
  })

const commandOf = (input: Record<string, unknown>): string | undefined =>
  typeof input.command === 'string' ? input.command : undefined

const statusOf = (word: string): ProcessStatus => {
  const w = word.toLowerCase()
  if (['complet', 'exit', 'done', 'success'].some(s => w.includes(s))) return 'completed'
  if (['kill', 'stop', 'cancel'].some(s => w.includes(s))) return 'killed'
  if (['fail', 'error'].some(s => w.includes(s))) return 'failed'
  return 'running'
}

/**
 * The artifacts an `Artifact` call made or changed, from the URLs its result mentions: only a publish counts (not
 * list, read, open, quickstart…); an update is the artifact it names, a new one is not the type it starts from.
 */
const publishedArtifacts = (input: Readonly<Record<string, unknown>>, mentioned: readonly string[]): string[] => {
  if ((input.action ?? 'publish') !== 'publish') return []
  if (typeof input.url === 'string') return [input.url]
  return mentioned.filter(url => url !== input.type_url)
}

/**
 * What this session did: the processes it started, the addresses and logins it gave,
 * the PRs it made or changed, the worktrees it created or entered, and what it produced.
 *
 * `main` is the conversation; `agents` are the session's subagents' transcripts, read for
 * their actions only (their prose never reached the person).
 */
export const extract = (main: readonly Msg[], agents: readonly Msg[] = []): Found => {
  const processes: FoundProcess[] = []
  const byTaskId = new Map<string, FoundProcess>()
  const urls = new Map<string, FoundUrl>()
  const accounts = new Map<string, Account>()
  const prs = new Map<string, FoundPr>()
  const worktreePaths = new Set<string>()
  const artifacts = new Map<string, ArtifactItem>()
  const publishedFiles = new Set<string>()

  const addPrUrls = (text: string) => {
    for (const p of pullUrls(text)) prs.set(p.url, { ref: p.url, url: p.url, repo: p.repo, number: p.number })
  }
  const addAccounts = (list: Account[]) => {
    for (const a of list) {
      const key = `${a.user}\u0000${a.password ?? ''}`
      const known = accounts.get(key)
      accounts.set(key, a.note === undefined && known?.note !== undefined ? { ...a, note: known.note } : a)
    }
  }
  const addLinks = (text: string) => {
    for (const link of designLinks(text)) {
      if (!artifacts.has(link)) {
        const host = new URL(link).hostname
        artifacts.set(link, { label: host.startsWith('www.') ? host.slice(4) : host, href: link, kind: 'link' })
      }
    }
  }
  const addFile = (path: string) => {
    if (!isDocument(path) || isNotArtifact(path)) return
    const href = fileHref(path)
    artifacts.set(href, { label: basename(path), href, kind: 'file', detail: path })
  }

  const read = (msg: Msg, isAgent: boolean) => {
    if (msg.role === 'user') {
      for (const n of taskNotifications(msg.text)) {
        const p = byTaskId.get(n.id)
        if (p) p.status = statusOf(n.status)
      }
    }
    if (msg.role === 'assistant' && !isAgent) {
      for (const u of localUrls(msg.text)) urls.set(u.url, u)
      addAccounts(findAccounts(msg.text))
      addAccounts(findLoginEmails(msg.text))
      addLinks(msg.text)
    }

    for (const use of msg.toolUses) {
      const out = use.text ?? ''
      const command = commandOf(use.input)

      if (use.tool === 'TaskStop' || use.tool === 'KillShell') {
        const id = use.input.task_id ?? use.input.shell_id
        const p = typeof id === 'string' ? byTaskId.get(id) : undefined
        const lower = out.toLowerCase()
        if (p && use.text !== undefined && !lower.includes('error') && !lower.includes('not found')) p.status = 'killed'
        continue
      }
      if (use.tool === 'EnterWorktree') {
        for (const path of absolutePaths(out)) if (path.toLowerCase().includes('worktree')) worktreePaths.add(clean(path))
        continue
      }

      if (SHELLS.has(use.tool) && command !== undefined) {
        const shell = shellOf(use.tool)
        for (const path of worktreeAddPaths(command, shell)) worktreePaths.add(path)

        const isBackground = use.input.run_in_background === true
        const isStarted = isStart(command, shell)
        if (isBackground || isStarted) {
          // what runs, without the heredocs and scripts the command only carries
          const ran = runText(command, shell)
          const found = new Map<string, FoundUrl>()
          for (const u of [...localUrls(ran), ...localUrls(out)]) found.set(u.url, u)
          for (const port of namedPorts(ran)) {
            if (![...found.values()].some(u => u.port === port)) {
              found.set(`http://localhost:${port}`, { url: `http://localhost:${port}`, port })
            }
          }
          const id = backgroundId(out)
          const p: FoundProcess = {
            id,
            command: (command.split('\n')[0] ?? '').slice(0, 160),
            status: isBackground ? (use.text === undefined || id !== undefined ? 'running' : 'failed') : 'started',
            isBackground,
            outputFile: outputFile(out),
            urls: [...found.values()],
          }
          processes.push(p)
          if (id !== undefined) byTaskId.set(id, p)
        }
        if (!isAgent && (isStarted || isBackground || isSeed(command, shell))) {
          addAccounts(findAccounts(out))
          addAccounts(findLoginEmails(out))
        }

        const writes = prWrites(command, shell)
        if (writes.length > 0 && use.text !== undefined) {
          addPrUrls(out)
          for (const w of writes) addPrUrls(w.text)
          for (const n of writes.flatMap(w => (w.number === undefined ? [] : [w.number]))) {
            if (![...prs.values()].some(p => p.number === n)) prs.set(`#${n}`, { ref: String(n), number: n })
          }
        }
      }

      if (!isAgent) {
        addLinks(out)
        if (use.tool === 'Write' && typeof use.input.file_path === 'string') addFile(use.input.file_path)
      }

      const mentioned = claudeUrls(out)
      const artifactUrls = use.tool === 'Artifact' ? publishedArtifacts(use.input, mentioned) : mentioned
      if (artifactUrls.length > 0 && !isAgent) {
        const isDoc = use.tool.includes('Claude_Docs')
        const filePath = typeof use.input.file_path === 'string' ? use.input.file_path : undefined
        if (filePath !== undefined) publishedFiles.add(fileHref(filePath))
        const title = typeof use.input.title === 'string' ? use.input.title : undefined
        const label = title ?? (filePath ? withoutExtension(basename(filePath)) : isDoc ? 'Claude Doc' : 'Artifact')
        for (const url of new Set(artifactUrls)) {
          const known = artifacts.get(url)
          artifacts.set(url, {
            label: known && known.label !== 'Artifact' && known.label !== 'Claude Doc' ? known.label : label,
            href: url,
            kind: isDoc ? 'doc' : 'artifact',
          })
        }
      }
    }
  }

  for (const msg of main) read(msg, false)
  for (const msg of agents) read(msg, true)

  for (const href of publishedFiles) artifacts.delete(href)

  const processUrls = new Set(processes.flatMap(p => p.urls.map(u => u.url)))
  const withPassword = new Set([...accounts.values()].filter(a => a.password !== undefined).map(a => a.user))

  return {
    processes,
    urls: [...urls.values()].filter(u => !processUrls.has(u.url)),
    accounts: [...accounts.values()].filter(a => a.password !== undefined || !withPassword.has(a.user)),
    prs: [...prs.values()],
    worktreePaths: [...worktreePaths],
    artifacts: [...artifacts.values()],
  }
}

/** `plan.v2.html` → `plan.v2` */
const withoutExtension = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

// ── command output ────────────────────────────────────────────────────────────────────────────────────

/** `…:8080` or `….3000` at the end of a netstat address: the port. */
const trailingPort = (address: string): number | undefined => {
  const digits = runEndBack(address, isDigit)
  const separator = address.charAt(digits - 1)
  return digits < address.length && digits > 0 && (separator === ':' || separator === '.') ? Number(address.slice(digits)) : undefined
}

/** Ports in LISTEN state from `netstat -an` (Windows, Linux, macOS). */
export const listeningPorts = (netstat: string): Set<number> => {
  const ports = new Set<number>()
  for (const line of lines(netstat)) {
    if (!line.toUpperCase().includes('LISTEN')) continue
    const port = words(line)
      .map(trailingPort)
      .find(p => p !== undefined)
    if (port !== undefined) ports.add(port)
  }
  return ports
}

export type CheckRun = { conclusion?: string | null; status?: string | null; state?: string | null }

const PASSING = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const FAILING = ['FAIL', 'ERROR', 'CANCEL', 'TIMED_OUT', 'ACTION_REQUIRED']

export const summarizeChecks = (rollup: readonly CheckRun[]) => {
  const sum = { pass: 0, fail: 0, pending: 0 }
  for (const c of rollup) {
    const v = (c.conclusion || c.state || c.status || '').toUpperCase()
    if (PASSING.some(p => v.includes(p))) sum.pass++
    else if (FAILING.some(f => v.includes(f))) sum.fail++
    else sum.pending++
  }
  return sum
}

/** The rest of the first line of a block that starts with `prefix` and has more after it. */
const lineAfter = (blockLines: readonly string[], prefix: string): string | undefined =>
  blockLines.find(l => l.startsWith(prefix) && l.length > prefix.length)?.slice(prefix.length)

/** `git worktree list --porcelain` → path + branch. */
export const parseWorktrees = (porcelain: string): { path: string; branch?: string }[] =>
  porcelain
    .split('\r\n')
    .join('\n')
    .split('\n\n')
    .flatMap(block => {
      const blockLines = block.split('\n')
      const path = lineAfter(blockLines, 'worktree ')
      const branch = lineAfter(blockLines, 'branch refs/heads/') ?? (blockLines.includes('detached') ? '(detached)' : undefined)
      return path === undefined ? [] : [{ path, branch }]
    })
