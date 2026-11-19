# The test data document

One Markdown file per environment of the project's entry, **in the repository**:
`docs/test_data_<label>.md`, where `<label>` is the label of the environment's check
(`docs/test_data_prod.md`, `docs/test_data_dev.md`). The check's `accounts` names it. session-hub reads it from
the checkout the session works in, at the session's start and on every refresh, whether the environment runs or
not, and shows it in the environment's tab (`🧪 <label> test data`).

## Shape

```markdown
# Test data: <label>

All values below are fake. Source of truth: <the seed scripts, compose files, test helpers it was taken from>.

## Accounts
| Role | Login | Password | Where | Notes |
|---|---|---|---|---|
| Tenant admin | `admin@shop.local` | `admin123` | /admin | seeded by the entrypoint |
| Customer | `customer1@example.com` | (e-mail only) | /panel | created by `npm run seed:demo` |

## URLs
| What | URL | Notes |
|---|---|---|
| App | https://app.localhost/ | |
| Mail (OTP codes) | http://localhost:8025 | MailHog |

## Bank accounts
| Name | Number | Notes |
|---|---|---|
| Default e2e | `PL00 1234 5678 9012 3456 7890 1234` | fake |

## Companies
| Name | NIP | Notes |
|---|---|---|
| Test company | `1111111111` | any NIP with a valid checksum works |

## Payment cards
| Card | Number | Expiry | CVC | Result |
|---|---|---|---|---|
| Visa OK | `4242 4242 4242 4242` | any future | any | paid |

## Notes
- How to sign in, the shortest paths, what not to touch.
```

## Rules

1. **Everything that can be listed is a table row**: accounts, URLs, bank accounts, companies (NIP, REGON), cards,
   phone numbers, discount codes, events, tenants. One value per cell, in backticks when it is meant to be
   copied. No values in prose, bullets, blockquotes or headings.
2. **Sections are `## ` headings**, in the order above; a section with nothing in it is left out. Another kind
   of test data gets its own `## ` section with its own table (`## Discount codes`: `| Code | Gives | Notes |`).
   No `###` subsections, no `---` rules, no blockquotes: a variant (another stack, another tenant) is a
   column (`Stack`) or a row, not a subsection.
3. **`## Notes` is the only section of bullets**: how to sign in, the shortest paths, warnings. Short, one fact
   per bullet.
4. **The Accounts table always has the columns `Role | Login | Password | Where | Notes`**, in that order and with
   those names (session-hub finds the logins by the `Login` and `Password` headers). A login without a password
   (e-mail-only sign-in, OAuth, a fake Google login) has `(e-mail only)` in the Password cell. Every login is
   its own row: `customer1..3@example.com` is three rows.
5. **Passwords**: local stacks list only the obviously fake seeded ones the repository already holds
   (`admin123`). Production and staging never hold a password: the cell says where it is kept
   (`(1Password: Shop prod)`). Never a value from `.env`, a secret store or a real person's data.
6. **Headings and columns in the project's language**, English or Polish, these names exactly:

   | English | Polish |
   |---|---|
   | `# Test data: <label>` | `# Dane testowe: <label>` |
   | `## Accounts` · `Role \| Login \| Password \| Where \| Notes` | `## Konta testowe` · `Rola \| Login \| Hasło \| Gdzie \| Uwagi` |
   | `## URLs` · `What \| URL \| Notes` | `## Adresy` · `Co \| URL \| Uwagi` |
   | `## Bank accounts` · `Name \| Number \| Notes` | `## Konta bankowe` · `Nazwa \| Numer \| Uwagi` |
   | `## Companies` · `Name \| NIP \| Notes` | `## Firmy` · `Nazwa \| NIP \| Uwagi` |
   | `## Payment cards` · `Card \| Number \| Expiry \| CVC \| Result` | `## Karty płatnicze` · `Karta \| Numer \| Ważność \| CVC \| Wynik` |
   | `## Notes` | `## Uwagi` |

   The bank accounts' column is `Number` / `Numer`, never `Account` / `Konto`: a table with a login-like
   column is taken for a table of logins.
7. **Under the title, at most two lines**: that the data is fake and where it comes from (the files to check when
   it drifts).

## Converting an existing document

A document the repository already keeps in another shape (a cheat sheet, `LOCAL_TEST_CREDENTIALS.md`, a README
section) is rewritten into this shape as `docs/test_data_<label>.md`: every account, URL, bank account, company,
card and code becomes a table row, prose about how things work becomes `## Notes` bullets, nothing is dropped.
A document serving several environments is split, one file per environment; data shared by all of them goes into
each. The old document stays where it is unless the person says otherwise; when it stays, its first line points
to the new ones.
