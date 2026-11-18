/** Plain-text scanning: the transcript's detectors read text with these, step by step, without regular expressions. */

export const isDigit = (c: string): boolean => c >= '0' && c <= '9'

export const isAsciiLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')

/** a letter, digit or `_` of the ASCII alphabet: what a word is made of */
export const isWordChar = (c: string): boolean => isAsciiLetter(c) || isDigit(c) || c === '_'

/** one whitespace or line-break character, the ones `trim` removes */
export const isSpace = (c: string): boolean => c !== '' && c.trim() === ''

/** The index right after the run of characters from `from` that all pass `test`. */
export const runEnd = (s: string, from: number, test: (c: string) => boolean): number => {
  let i = from
  while (i < s.length && test(s.charAt(i))) i++
  return i
}

/** The index right after one or more whitespace characters at `i`; undefined when there are none. */
export const afterSpaces = (s: string, i: number): number | undefined => {
  const end = runEnd(s, i, isSpace)
  return end > i ? end : undefined
}

/** Nothing of a word at `i`: the end of the text or a character that is no letter, digit or `_`. */
export const endsWord = (s: string, i: number): boolean => i >= s.length || !isWordChar(s.charAt(i))

/** Where `word` starts a word in `s`: no letter, digit or `_` right before it. */
export const wordStarts = (s: string, word: string): number[] => {
  const found: number[] = []
  for (let i = s.indexOf(word); i >= 0; i = s.indexOf(word, i + 1)) {
    if (i === 0 || !isWordChar(s.charAt(i - 1))) found.push(i)
  }
  return found
}

/** `word` stands in `s` as a whole word. */
export const hasWord = (s: string, word: string): boolean => wordStarts(s, word).some(i => endsWord(s, i + word.length))

/** Every index at which `needle` occurs in `s`. */
export const indexesOf = (s: string, needle: string): number[] => {
  const found: number[] = []
  for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + 1)) found.push(i)
  return found
}

/** `first`, then at most one character other than a line break, then `second`: `sign in`, `sign-in`, `signin`. */
export const hasNearly = (s: string, first: string, second: string): boolean =>
  indexesOf(s, first).some(i => {
    const after = i + first.length
    const between = s.charAt(after)
    return s.startsWith(second, after) || (between !== '\n' && between !== '\r' && s.startsWith(second, after + 1))
  })

/** The lines of a text broken by `\n` or `\r\n`. */
export const lines = (text: string): string[] => {
  const parts = text.split('\n')
  return parts.map((l, i) => (i < parts.length - 1 && l.endsWith('\r') ? l.slice(0, -1) : l))
}

/** The whitespace-separated words of a text. */
export const words = (s: string): string[] => {
  const found: string[] = []
  let i = runEnd(s, 0, isSpace)
  while (i < s.length) {
    const end = runEnd(s, i, c => !isSpace(c))
    found.push(s.slice(i, end))
    i = runEnd(s, end, isSpace)
  }
  return found
}
