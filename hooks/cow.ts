const TEST_COMMANDS = [
  'npm test',
  'npm run test',
  'npx playwright test',
  'playwright test',
  'dotnet test',
  'vitest',
  'claude plugin test',
  'bun test',
]

export const isTestCommand = (command: string): boolean => TEST_COMMANDS.some(t => command.includes(t))

export const isCommitCommand = (command: string): boolean => command.includes('git commit')

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isNumber = (s: string): boolean => s !== '' && [...s].every(isDigit)

/** Drops ANSI escape sequences (ESC [ … letter) so colored test output reads as words. */
export const withoutAnsi = (text: string): string => {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text.charAt(i) === '\u001b') {
      i++
      while (i < text.length) {
        const c = text.charAt(i).toLowerCase()
        i++
        if (c >= 'a' && c <= 'z') break
      }
      continue
    }
    out += text.charAt(i)
    i++
  }
  return out
}

const PASS_WORDS = new Set(['pass', 'passed', 'passing'])
const FAIL_WORDS = new Set(['fail', 'failed', 'failing'])
const PUNCTUATION = [',', '|', '(', ')', '[', ']']

export type Counts = { pass?: number; fail?: number }

/**
 * The summary of a test run, as the last `N passed` / `N failed` (Playwright, Vitest, bun)
 * or `Passed: N` / `Failed: N` (dotnet) it printed.
 */
export const testCounts = (output: string): Counts => {
  let text = withoutAnsi(output)
  for (const p of PUNCTUATION) text = text.split(p).join(' ')
  const words = text
    .split('\n')
    .join(' ')
    .split('\t')
    .join(' ')
    .split(' ')
    .filter(w => w !== '')
  const counts: Counts = {}
  words.forEach((word, i) => {
    const next = (words[i + 1] ?? '').toLowerCase()
    const lower = word.toLowerCase()
    if (isNumber(word) && PASS_WORDS.has(next)) counts.pass = Number(word)
    if (isNumber(word) && FAIL_WORDS.has(next)) counts.fail = Number(word)
    const value = words[i + 1] ?? ''
    if (lower === 'passed:' && isNumber(value)) counts.pass = Number(value)
    if (lower === 'failed:' && isNumber(value)) counts.fail = Number(value)
  })
  return counts
}

/** `[main 7318d7b] subject` → `7318d7b subject`. */
export const commitLine = (stdout: string): string | undefined => {
  const line = stdout
    .split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith('[') && l.includes(']'))
  if (line === undefined) return undefined
  const head = line.slice(1, line.indexOf(']')).split(' ')
  const sha = head[head.length - 1] ?? ''
  const subject = line.slice(line.indexOf(']') + 1).trim()
  return sha === '' ? undefined : `${sha} ${subject}`.trim()
}

const MAX_SAY = 48

const fit = (text: string): string => (text.length > MAX_SAY ? `${text.slice(0, MAX_SAY - 1)}…` : text)

export type CowLine = { say: string; isRed: boolean }

/** What the cow says under a shell call, or nothing: only a red test run or a commit gets one. */
export const cowSays = (command: string, isErrored: boolean, output: string): CowLine | undefined => {
  if (isTestCommand(command)) {
    const { pass, fail } = testCounts(output)
    const isRed = isErrored || (fail ?? 0) > 0
    if (!isRed) return undefined
    const parts = [fail !== undefined && `${fail} fail`, pass !== undefined && `${pass} pass`].filter(Boolean)
    return { say: fit(parts.length > 0 ? `Muuu… ${parts.join(', ')}` : 'Muuu… testy czerwone'), isRed: true }
  }
  if (isCommitCommand(command) && !isErrored) {
    const commit = commitLine(output)
    return commit === undefined ? undefined : { say: fit(`Muuu, commit ${commit}`), isRed: false }
  }
  return undefined
}

/** cowsay, by hand. */
export const cow = (say: string): string[] => {
  const bar = '-'.repeat(say.length + 2)
  return [
    ` ${'_'.repeat(say.length + 2)}`,
    `< ${say} >`,
    ` ${bar}`,
    '        \\   ^__^',
    '         \\  (oo)\\_______',
    '            (__)\\       )\\/\\',
    '                ||----w |',
    '                ||     ||',
  ]
}

/** A shell call's result as text: Bash/PowerShell record `{ stdout, stderr }`, an error is its text. */
export const outputText = (output: unknown): string => {
  if (typeof output === 'string') return output
  if (output !== null && typeof output === 'object') {
    const o = output as { stdout?: unknown; stderr?: unknown }
    return [o.stdout, o.stderr].filter(s => typeof s === 'string').join('\n')
  }
  return ''
}
