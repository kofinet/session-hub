import { expect, test } from 'claude-code/testing'

import { parseLanguage, textsFor } from '../hooks/i18n'

test('the status line counts accounts with the right plural in each language', async () => {
  const en = textsFor('en').statusLine.accounts
  const pl = textsFor('pl').statusLine.accounts
  expect([1, 2, 5].map(en)).toEqual(['1 account', '2 accounts', '5 accounts'])
  expect([1, 2, 4, 5, 12, 14, 22, 25].map(pl)).toEqual(['1 konto', '2 konta', '4 konta', '5 kont', '12 kont', '14 kont', '22 konta', '25 kont'])
})

test('a long document says how many lines are left, in either language', async () => {
  expect(textsFor('en').pane.moreLines(30)).toBe('… 30 more lines in the document')
  expect([1, 3, 30].map(textsFor('pl').pane.moreLines)).toEqual([
    '… jeszcze 1 wiersz w dokumencie',
    '… jeszcze 3 wiersze w dokumencie',
    '… jeszcze 30 wierszy w dokumencie',
  ])
})

test('only en and pl are languages', async () => {
  expect(['en', 'pl', 'de', undefined, 1].map(parseLanguage)).toEqual(['en', 'pl', undefined, undefined, undefined])
})
