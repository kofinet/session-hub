import { expect, test } from 'claude-code/testing'

import { accountsSection, docLines, docSections } from '../hooks/doc'

test('a document is shown line by line: headings bold, markdown marks gone, runs of blank lines as one', async () => {
  const doc = [
    '# Test data — production',
    '',
    '',
    '## Konto bankowe (NRB)',
    '`PL00 1234 5678 0000 0000 0000 0000`',
    'Test bank, **not** a real account.',
    '- Data: dowolna przyszła (12/34)',
  ].join('\r\n')
  expect(docLines(doc)).toEqual({
    lines: [
      { text: 'Test data — production', isBold: true },
      { text: '', isBold: false },
      { text: 'Konto bankowe (NRB)', isBold: true },
      { text: 'PL00 1234 5678 0000 0000 0000 0000', isBold: false },
      { text: 'Test bank, not a real account.', isBold: false },
      { text: '- Data: dowolna przyszła (12/34)', isBold: false },
    ],
    hidden: 0,
  })
})

test('a table is shown in aligned columns, its header bold and its rule left out', async () => {
  const doc = ['| Role | Login | Password |', '|---|:---:|---|', '| **Admin** | `admin@shop.local` | (1Password: Shop prod) |', '| Op | op | op1 |'].join(
    '\n',
  )
  expect(docLines(doc).lines).toEqual([
    { text: 'Role   Login             Password', isBold: true },
    { text: 'Admin  admin@shop.local  (1Password: Shop prod)', isBold: false },
    { text: 'Op     op                op1', isBold: false },
  ])
})

test('two tables apart from each other are aligned each on its own', async () => {
  const doc = ['| A | B |', '|---|---|', '| long cell | x |', '', '| C | D |', '|---|---|', '| y | z |'].join('\n')
  expect(docLines(doc).lines.map(l => l.text)).toEqual(['A          B', 'long cell  x', '', 'C  D', 'y  z'])
})

test('a long document is cut, saying how many lines are left out', async () => {
  const doc = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n')
  const shown = docLines(doc, 200)
  expect(shown.lines.length).toBe(200)
  expect(shown.lines[199]).toEqual({ text: 'line 200', isBold: false })
  expect(shown.hidden).toBe(50)
})

test('leading and trailing blank lines are not shown', async () => {
  expect(docLines('\n\n# A\ntext\n\n\n').lines).toEqual([
    { text: 'A', isBold: true },
    { text: 'text', isBold: false },
  ])
})

test('a document splits into its ## sections, the text before the first one kept as its head', async () => {
  const doc = [
    '# Test data: staging',
    'Shared by the QA team.',
    '',
    '## Accounts',
    '| Role | Login |',
    '|---|---|',
    '| Admin | qa@shop.example |',
    '',
    '## Payments',
    '### Stripe',
    '4242 4242 4242 4242',
    '## Notes',
  ].join('\n')
  expect(docSections(doc)).toEqual({
    head: [
      { text: 'Test data: staging', isBold: true },
      { text: 'Shared by the QA team.', isBold: false },
    ],
    sections: [
      {
        title: 'Accounts',
        lines: [
          { text: 'Role   Login', isBold: true },
          { text: 'Admin  qa@shop.example', isBold: false },
        ],
      },
      {
        title: 'Payments',
        lines: [
          { text: 'Stripe', isBold: true },
          { text: '4242 4242 4242 4242', isBold: false },
        ],
      },
      { title: 'Notes', lines: [] },
    ],
  })
})

test('the accounts section is the one named accounts, logins or konta, else the first', async () => {
  expect(accountsSection(['URLs', 'Konta testowe', 'Notes'])).toBe(1)
  expect(accountsSection(['Test accounts', 'Payments'])).toBe(0)
  expect(accountsSection(['URLs', 'Logins'])).toBe(1)
  expect(accountsSection(['URLs', 'Payments'])).toBe(0)
  expect(accountsSection([])).toBe(-1)
})
