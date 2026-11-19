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

/** The section unfolded by default: the one about accounts and logins, else the first; -1 when there is none. */
export const accountsSection = (titles: readonly string[]): number => {
  const named = titles.findIndex(t => ACCOUNT_WORDS.some(w => t.toLowerCase().includes(w)))
  return named >= 0 ? named : titles.length > 0 ? 0 : -1
}
