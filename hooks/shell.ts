import { isSpace, isWordChar, lines } from './scan'

/** A word of a shell command, its quotes removed; `isQuoted` when any of it was quoted (a message, a script). */
export type Word = { text: string; isQuoted: boolean }

/** A simple command: its words, the command name at `at` (after `A=1`, `sudo`, `nohup`…). */
export type SimpleCommand = { words: Word[]; at: number }

/** Bash escapes with a backslash; PowerShell does not (a backslash there is a Windows path). */
export type Shell = 'bash' | 'powershell'

/** What a line carries but does not run: a heredoc's or a PowerShell here-string's body. */
type PendingBody = { end: string; stripsTabs: boolean }

const SEPARATORS = ';&|()'
const PREFIX_COMMANDS = new Set(['sudo', 'nohup', 'exec', 'time', 'env', 'command'])

const isAssignment = (word: string): boolean => {
  const eq = word.indexOf('=')
  return eq > 0 && !isDigitAt(word, 0) && [...word.slice(0, eq)].every(isWordChar)
}

const isDigitAt = (s: string, i: number): boolean => s.charAt(i) >= '0' && s.charAt(i) <= '9'

/** `<<'EOF'`, `<<-EOF`, `<<"EOF"` at `i` (just after `<<`): the delimiter and where the operator ends. */
const heredocAt = (s: string, i: number): { body: PendingBody; end: number } | undefined => {
  let at = i
  const stripsTabs = s.charAt(at) === '-'
  if (stripsTabs) at++
  while (s.charAt(at) === ' ' || s.charAt(at) === '\t') at++
  const quote = s.charAt(at) === "'" || s.charAt(at) === '"' ? s.charAt(at) : ''
  if (quote !== '') {
    const close = s.indexOf(quote, at + 1)
    if (close < 0) return undefined
    return { body: { end: s.slice(at + 1, close), stripsTabs }, end: close + 1 }
  }
  let end = at
  while (end < s.length && !isSpace(s.charAt(end)) && !SEPARATORS.includes(s.charAt(end)) && s.charAt(end) !== '<' && s.charAt(end) !== '>') end++
  return end > at ? { body: { end: s.slice(at, end), stripsTabs }, end } : undefined
}

/** The index after the body lines that start at `from`, up to and including the line that ends the body. */
const afterBody = (s: string, from: number, body: PendingBody): number => {
  let at = from
  while (at < s.length) {
    const lineEnd = s.indexOf('\n', at)
    const next = lineEnd < 0 ? s.length : lineEnd + 1
    const line = lines(s.slice(at, lineEnd < 0 ? s.length : lineEnd))[0] ?? ''
    const plain = body.stripsTabs ? line.trimStart() : line
    if (plain === body.end || plain.trimEnd() === body.end) return next
    at = next
  }
  return s.length
}

/**
 * The simple commands of a shell command line (Bash or PowerShell), split at `;`, `&`, `|`, `&&`, `||`, brackets
 * and line breaks. Heredoc bodies, PowerShell here-strings and comments are left out: they are carried, not run.
 */
export const simpleCommands = (command: string, shell: Shell = 'bash'): SimpleCommand[] => {
  const commands: SimpleCommand[] = []
  let words: Word[] = []
  let text = ''
  let isQuoted = false
  let inWord = false
  const pending: PendingBody[] = []

  const endWord = () => {
    if (inWord) words.push({ text, isQuoted })
    text = ''
    isQuoted = false
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push({ words, at: commandAt(words) })
    words = []
  }

  let i = 0
  while (i < command.length) {
    const c = command.charAt(i)
    if (c === '\n') {
      endCommand()
      i++
      while (pending.length > 0) i = afterBody(command, i, pending.shift() as PendingBody)
      continue
    }
    if (c === '\\' && shell === 'bash' && i + 1 < command.length) {
      if (command.charAt(i + 1) !== '\n') {
        text += command.charAt(i + 1)
        inWord = true
      }
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1)
      const end = close < 0 ? command.length : close
      text += command.slice(i + 1, end)
      isQuoted = true
      inWord = true
      i = end + 1
      continue
    }
    if (c === '@' && !inWord && (command.charAt(i + 1) === "'" || command.charAt(i + 1) === '"') && (command.charAt(i + 2) === '\n' || command.startsWith('\r\n', i + 2))) {
      // a PowerShell here-string: its body runs up to a line that starts with '@ or "@
      const closing = `${command.charAt(i + 1)}@`
      let at = command.indexOf('\n', i) + 1
      while (at < command.length && !command.startsWith(closing, at)) {
        const lineEnd = command.indexOf('\n', at)
        at = lineEnd < 0 ? command.length : lineEnd + 1
      }
      text += '@here-string'
      isQuoted = true
      inWord = true
      i = Math.min(command.length, at + 2)
      continue
    }
    if (c === '<' && command.startsWith('<<', i) && command.charAt(i + 2) !== '<') {
      endWord()
      const heredoc = heredocAt(command, i + 2)
      if (heredoc !== undefined) {
        pending.push(heredoc.body)
        i = heredoc.end
        continue
      }
    }
    // `#12` after `gh pr merge` is how a PR is named, not a comment
    if (c === '#' && !inWord && !isDigitAt(command, i + 1)) {
      const lineEnd = command.indexOf('\n', i)
      i = lineEnd < 0 ? command.length : lineEnd
      continue
    }
    if (SEPARATORS.includes(c)) {
      endCommand()
      i++
      continue
    }
    if (isSpace(c)) {
      endWord()
      i++
      continue
    }
    text += c
    inWord = true
    i++
  }
  endCommand()
  return commands
}

/** Where the command name is: after assignments (`PORT=3000`) and prefixes (`sudo`, `nohup`, `env`…). */
const commandAt = (words: readonly Word[]): number => {
  let at = 0
  while (at < words.length && !(words[at]?.isQuoted ?? true) && (isAssignment(words[at]?.text ?? '') || PREFIX_COMMANDS.has(words[at]?.text ?? ''))) at++
  return at
}

/** The command's name without its folder and in small letters: `/usr/bin/Docker` → `docker`. */
export const commandName = (c: SimpleCommand): string => {
  const word = c.words[c.at]
  if (word === undefined || word.isQuoted) return ''
  const t = word.text
  return t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1).toLowerCase()
}

/** The command's arguments, after its name. */
export const argsOf = (c: SimpleCommand): Word[] => c.words.slice(c.at + 1)

/** The words a command line runs with, quoted ones included, joined by spaces: its text without carried bodies. */
export const runText = (command: string, shell: Shell = 'bash'): string =>
  simpleCommands(command, shell)
    .map(c => c.words.map(w => w.text).join(' '))
    .join(' ; ')
