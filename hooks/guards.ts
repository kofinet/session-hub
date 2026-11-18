const WORKTREES = '/.claude/worktrees/'

/** `C:\A\b\`, `c:/a/b`, `/c/a/b` (Git Bash) → `c:/a/b`. */
export const normPath = (path: string): string => {
  let p = path.split('\\').join('/').toLowerCase()
  if (p.length >= 3 && p.charAt(0) === '/' && p.charAt(2) === '/' && isLetter(p.charAt(1))) {
    p = `${p.charAt(1)}:${p.slice(2)}`
  }
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

const isLetter = (c: string): boolean => c >= 'a' && c <= 'z'
const isDigit = (c: string): boolean => c >= '0' && c <= '9'

/** `/x`, `\x`, `\\server\x`, `C:/x`, `C:\x`, `/c/x` (Git Bash) */
export const isAbsolute = (path: string): boolean => {
  const p = normPath(path)
  return p.startsWith('/') || (p.length >= 2 && isLetter(p.charAt(0)) && p.charAt(1) === ':')
}

export const joinPath = (base: string, rel: string): string => {
  if (isAbsolute(rel)) return normPath(rel)
  const parts = normPath(base).split('/')
  for (const piece of normPath(rel).split('/')) {
    if (piece === '' || piece === '.') continue
    if (piece === '..') parts.pop()
    else parts.push(piece)
  }
  return parts.join('/')
}

/** Inside the main checkout and not inside one of its `.claude/worktrees`. */
export const isInMainCheckout = (path: string, mainRoot: string): boolean => {
  const p = normPath(path)
  const root = normPath(mainRoot)
  if (p !== root && !p.startsWith(`${root}/`)) return false
  return !`${p}/`.startsWith(`${root}${WORKTREES}`)
}

/** `git worktree list --porcelain` → the worktrees' paths, the main checkout first. */
export const worktreePaths = (porcelain: string): string[] =>
  porcelain
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))

/** `054_order_number.sql` → 54: the digits before the first `_`. */
export const migrationNumber = (name: string): number | undefined => {
  const underscore = name.indexOf('_')
  const digits = name.slice(0, underscore)
  return underscore > 0 && [...digits].every(isDigit) ? Number(digits) : undefined
}

export type MigrationTarget = { checkout: string; dir: string; name: string; number: number; width: number }

/** A new migration file being written: which checkout, which of the project's migration folders, which number. */
export const migrationTarget = (
  filePath: string,
  checkouts: readonly string[],
  migrationDirs: readonly string[],
): MigrationTarget | undefined => {
  const p = normPath(filePath)
  const checkout = [...checkouts]
    .map(normPath)
    .filter(root => p.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0]
  if (checkout === undefined) return undefined
  const rel = p.slice(checkout.length + 1)
  const slash = rel.lastIndexOf('/')
  const dir = migrationDirs.find(d => normPath(d) === rel.slice(0, slash))
  const name = filePath.split('\\').join('/').split('/').pop() ?? ''
  const number = migrationNumber(name)
  return dir === undefined || number === undefined
    ? undefined
    : { checkout, dir, name, number, width: name.indexOf('_') }
}

/** Migration files one place holds: a worktree on disk, or `origin/main`. */
export type Listing = { where: string; names: readonly string[] }

export type Clash = { taken: { where: string; name: string }[]; nextFree: number }

/** The number is taken when another file anywhere already carries it under a different name. */
export const migrationClash = (target: MigrationTarget, listings: readonly Listing[]): Clash | undefined => {
  const numbered = listings.flatMap(l =>
    l.names.flatMap(name => {
      const n = migrationNumber(name)
      return n === undefined ? [] : [{ where: l.where, name, number: n }]
    }),
  )
  const taken = numbered
    .filter(m => m.number === target.number && m.name.toLowerCase() !== target.name.toLowerCase())
    .map(({ where, name }) => ({ where, name }))
  if (taken.length === 0) return undefined
  const highest = Math.max(target.number, ...numbered.map(m => m.number))
  return { taken, nextFree: highest + 1 }
}

export const padNumber = (n: number, width: number): string => String(n).padStart(width, '0')

/** git subcommands that commit, move a branch or rewrite the working tree. */
const MUTATING = new Set(['commit', 'checkout', 'switch', 'merge', 'rebase', 'reset', 'cherry-pick', 'revert', 'am', 'stash', 'restore'])
const READ_ONLY_STASH = new Set(['list', 'show'])
const SEPARATORS = ['&&', '||', ';', '|', '\n']

const segments = (command: string): string[] => {
  let parts = [command]
  for (const sep of SEPARATORS) parts = parts.flatMap(p => p.split(sep))
  return parts.map(p => p.trim()).filter(p => p !== '')
}

const unquote = (token: string): string => {
  const first = token.charAt(0)
  return (first === '"' || first === "'") && token.endsWith(first) ? token.slice(1, -1) : token
}

const tokens = (segment: string): string[] =>
  segment
    .split(' ')
    .map(t => t.trim())
    .filter(t => t !== '')
    .map(unquote)

/**
 * The git calls in a shell command that change the checkout they run in, with the folder each runs in
 * (following `cd` and `git -C`), starting from `cwd`.
 */
export const mutatingGitCalls = (command: string, cwd: string): { sub: string; dir: string }[] => {
  let here = normPath(cwd)
  const found: { sub: string; dir: string }[] = []
  for (const segment of segments(command)) {
    const words = tokens(segment)
    if (words[0] === 'cd' && words[1] !== undefined) {
      here = joinPath(here, words[1])
      continue
    }
    if (words[0] !== 'git') continue
    let dir = here
    let i = 1
    while (i < words.length && (words[i] ?? '').startsWith('-')) {
      const option = words[i]
      if (option === '-C') dir = joinPath(here, words[i + 1] ?? '.')
      i += option === '-C' || option === '-c' ? 2 : 1
    }
    const sub = words[i]
    if (sub === undefined || !MUTATING.has(sub)) continue
    if (sub === 'stash' && READ_ONLY_STASH.has(words[i + 1] ?? '')) continue
    found.push({ sub, dir })
  }
  return found
}
