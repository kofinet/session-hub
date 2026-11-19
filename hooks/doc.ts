/** A line of a Markdown document as the pane shows it. */
export type DocLine = { text: string; isBold: boolean }

const DEFAULT_MAX_LINES = 200
const COLUMN_GAP = '  '

const withoutMarks = (s: string): string => s.split('**').join('').split('`').join('')

const isTableRow = (line: string): boolean => line.trim().startsWith('|')

const cellsOf = (line: string): string[] => {
  const trimmed = line.trim()
  const inner = trimmed.endsWith('|') && trimmed.length > 1 ? trimmed.slice(1, -1) : trimmed.slice(1)
  return inner.split('|').map(c => withoutMarks(c.trim()))
}

/** `|---|:---:|` */
const isRule = (cells: readonly string[]): boolean =>
  cells.length > 0 && cells.every(c => c.length > 0 && [...c].every(ch => ch === '-' || ch === ':' || ch === ' '))

/** `## Title` → `Title`; anything else is no heading. */
const headingText = (line: string): string | undefined => {
  const trimmed = line.trim()
  let level = 0
  while (trimmed.charAt(level) === '#') level++
  if (level === 0 || level > 6 || (trimmed.length > level && trimmed.charAt(level) !== ' ')) return undefined
  return withoutMarks(trimmed.slice(level).trim())
}

/** A block of table rows → its lines, columns padded to their widest cell, the header (the row above the rule) bold. */
const tableLines = (rows: readonly string[]): DocLine[] => {
  const parsed = rows.map(cellsOf)
  const ruleAt = parsed.findIndex(isRule)
  const body = parsed.filter((_, i) => i !== ruleAt)
  const columns = Math.max(...body.map(r => r.length))
  const widths = Array.from({ length: columns }, (_, c) => Math.max(...body.map(r => (r[c] ?? '').length)))
  return parsed.flatMap((cells, i) => {
    if (i === ruleAt) return []
    const text = widths
      .map((w, c) => (c === columns - 1 ? (cells[c] ?? '') : (cells[c] ?? '').padEnd(w)))
      .join(COLUMN_GAP)
      .trimEnd()
    return [{ text, isBold: ruleAt > 0 && i < ruleAt }]
  })
}

/**
 * A Markdown document (an environment's test data) as plain lines for the pane: headings and table headers bold,
 * tables in aligned columns, `**` and backticks dropped, blank runs as one blank line. At most `maxLines`;
 * `hidden` says how many more there are.
 */
export const docLines = (text: string, maxLines: number = DEFAULT_MAX_LINES): { lines: DocLine[]; hidden: number } => {
  const source = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const all: DocLine[] = []
  for (let i = 0; i < source.length; i++) {
    const line = source[i] ?? ''
    if (isTableRow(line)) {
      const rows: string[] = []
      while (i < source.length && isTableRow(source[i] ?? '')) rows.push(source[i++] ?? '')
      i--
      all.push(...tableLines(rows))
      continue
    }
    if (line.trim() === '') {
      if (all.length > 0 && all[all.length - 1]?.text !== '') all.push({ text: '', isBold: false })
      continue
    }
    const heading = headingText(line)
    all.push(heading === undefined ? { text: withoutMarks(line.trimEnd()), isBold: false } : { text: heading, isBold: true })
  }
  while (all.length > 0 && all[all.length - 1]?.text === '') all.pop()
  return { lines: all.slice(0, maxLines), hidden: Math.max(0, all.length - maxLines) }
}

/** `## Title` → `Title`; any other line is no section heading. */
const sectionTitle = (line: string): string | undefined => {
  const trimmed = line.trim()
  return trimmed.startsWith('## ') ? withoutMarks(trimmed.slice(3).trim()) : undefined
}

/**
 * A test data document as the environment's tab shows it: what comes before the first `## ` heading (its title,
 * a note) as `head`, then each `## ` section with its lines, folded or unfolded by the person.
 */
export const docSections = (text: string): { head: DocLine[]; sections: { title: string; lines: DocLine[] }[] } => {
  const source = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const parts: { title: string | undefined; rows: string[] }[] = [{ title: undefined, rows: [] }]
  for (const line of source) {
    const title = sectionTitle(line)
    if (title !== undefined) parts.push({ title, rows: [] })
    else parts[parts.length - 1]?.rows.push(line)
  }
  const [head, ...rest] = parts
  return {
    head: docLines((head?.rows ?? []).join('\n'), Number.MAX_SAFE_INTEGER).lines,
    sections: rest.map(p => ({ title: p.title ?? '', lines: docLines(p.rows.join('\n'), Number.MAX_SAFE_INTEGER).lines })),
  }
}

const ACCOUNT_WORDS = ['account', 'login', 'konta', 'konto', 'loginy']

/** a bank account is test data, not a login */
const BANK_WORDS = ['bank', 'nrb', 'iban']

/** `## Accounts`, `## Konta testowe`, `## Test logins`: the section the accounts table stands for. */
export const isAccountsTitle = (title: string): boolean => {
  const lower = title.toLowerCase()
  return ACCOUNT_WORDS.some(w => lower.includes(w)) && !BANK_WORDS.some(w => lower.includes(w))
}

/** the columns that make a table one of accounts */
const LOGIN_COLUMNS = new Set(['user', 'username', 'login', 'email', 'e-mail', 'użytkownik', 'uzytkownik', 'konto'])
/** the columns that make a table one of addresses */
const ADDRESS_COLUMNS = new Set(['url', 'urls', 'adres', 'address', 'endpoint'])

/**
 * The document without its tables of accounts (a table whose header names a login column): the environment's tab
 * shows those accounts in a table of its own, and every other line where the document has it.
 */
export const withoutAccountTables = (text: string): string => {
  const lines = text.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!isTableRow(line)) {
      kept.push(line)
      continue
    }
    const rows: string[] = []
    while (i < lines.length && isTableRow(lines[i] ?? '')) rows.push(lines[i++] ?? '')
    i--
    const header = cellsOf(rows[0] ?? '').map(c => c.toLowerCase())
    // `| URL | Co | Login |` lists addresses, how to sign in on each: no accounts
    const isAccounts = header.some(c => LOGIN_COLUMNS.has(c)) && !header.some(c => ADDRESS_COLUMNS.has(c))
    if (!isAccounts) kept.push(...rows)
  }
  return kept.join('\n')
}

/** A value the environment's tab lists, with what its table row says about it. */
export type Fact = { value: string; note?: string }

/** The data of a test data document by kind, whatever shape the document gives it in; its prose is left out. */
export type DocFacts = { urls: Fact[]; bankAccounts: Fact[]; companies: Fact[]; cards: Fact[] }

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z'
const isLetter = (c: string): boolean => c.toLowerCase() !== c.toUpperCase()

const URL_STARTS = ['https://', 'http://']
const URL_STOP = ' \t|`)"\'<>]'
const URL_TRAILING = '.,;:!?'

/** `http://` and `https://` addresses in a line, trailing punctuation left out. */
const urlsIn = (line: string): string[] => {
  const found: string[] = []
  for (let p = 0; p < line.length; p++) {
    if (p > 0 && isLetter(line.charAt(p - 1))) continue
    const start = URL_STARTS.find(s => line.startsWith(s, p))
    if (start === undefined) continue
    let end = p + start.length
    while (end < line.length && !URL_STOP.includes(line.charAt(end))) end++
    while (end > p + start.length && URL_TRAILING.includes(line.charAt(end - 1))) end--
    if (end > p + start.length) found.push(line.slice(p, end))
    p = end
  }
  return found
}

/** Two capital letters right before `at` (`PL`), not the end of a longer word: an IBAN's country. */
const countryBefore = (line: string, at: number): string | undefined => {
  const country = line.slice(at - 2, at)
  const isAlone = at - 2 === 0 || !isLetter(line.charAt(at - 3))
  return at >= 2 && [...country].every(isUpper) && isAlone ? country : undefined
}

/** Runs of digits, single spaces or hyphens between them: `00 1234 5678`, `111-111-11-11`; an IBAN's country letters kept. */
const numbersIn = (line: string): { shown: string; digits: string }[] => {
  const found: { shown: string; digits: string }[] = []
  let i = 0
  while (i < line.length) {
    const previous = i > 0 ? line.charAt(i - 1) : ''
    const glued = isLetter(previous) ? countryBefore(line, i) : undefined
    if (!isDigit(line.charAt(i)) || isDigit(previous) || (isLetter(previous) && glued === undefined)) {
      i++
      continue
    }
    let end = i
    while (end < line.length) {
      const c = line.charAt(end)
      const isSeparator = (c === ' ' || c === '-') && isDigit(line.charAt(end + 1))
      if (!isDigit(c) && !isSeparator) break
      end++
    }
    const run = line.slice(i, end)
    const before = line.slice(0, i).trimEnd()
    const spaced = glued === undefined ? countryBefore(before, before.length) : undefined
    const shown = glued !== undefined ? `${glued}${run}` : spaced !== undefined ? `${spaced} ${run}` : run
    found.push({ shown, digits: [...run].filter(isDigit).join('') })
    i = end
  }
  return found
}

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7]
const NRB_DIGITS = 26
const NIP_DIGITS = 10
const CARD_MIN_DIGITS = 13
const CARD_MAX_DIGITS = 19

const isNip = (digits: string): boolean => {
  if (digits.length !== NIP_DIGITS) return false
  const sum = NIP_WEIGHTS.reduce((acc, w, i) => acc + w * Number(digits.charAt(i)), 0)
  return sum % 11 === Number(digits.charAt(9))
}

const isLuhn = (digits: string): boolean => {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits.charAt(digits.length - 1 - i))
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

const numberKind = (digits: string): Exclude<keyof DocFacts, 'urls'> | undefined => {
  if (digits.length === NRB_DIGITS) return 'bankAccounts'
  if (isNip(digits)) return 'companies'
  if (digits.length >= CARD_MIN_DIGITS && digits.length <= CARD_MAX_DIGITS && isLuhn(digits)) return 'cards'
  return undefined
}

const EMPTY_CELLS = new Set(['', '—', '-', '–'])

export const docFacts = (text: string): DocFacts => {
  const facts: DocFacts = { urls: [], bankAccounts: [], companies: [], cards: [] }
  const keys = new Map<string, Fact>()
  const add = (kind: keyof DocFacts, key: string, fact: Fact) => {
    const known = keys.get(`${kind}:${key}`)
    if (known === undefined) {
      keys.set(`${kind}:${key}`, fact)
      facts[kind].push(fact)
    } else if (known.note === undefined && fact.note !== undefined) {
      known.note = fact.note
    }
  }
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const cells = isTableRow(line) ? cellsOf(line) : [withoutMarks(line)]
    if (isRule(cells)) continue
    cells.forEach((cell, c) => {
      const others = cells.filter((o, j) => j !== c && !EMPTY_CELLS.has(o))
      const note = isTableRow(line) && others.length > 0 ? { note: others.join(' · ') } : {}
      for (const url of urlsIn(cell)) add('urls', url.endsWith('/') ? url.slice(0, -1) : url, { value: url, ...note })
      for (const n of numbersIn(cell)) {
        const kind = numberKind(n.digits)
        if (kind !== undefined) add(kind, n.digits, { value: n.shown, ...note })
      }
    })
  }
  return facts
}
