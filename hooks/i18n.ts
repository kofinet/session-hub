import type { ProcessStatus } from '../types'

/** The interface's language, chosen at install (`/session-hub:modinstal`) and kept in the settings. */
export type Language = 'en' | 'pl'

export const LANGUAGES: readonly Language[] = ['en', 'pl']
export const DEFAULT_LANGUAGE: Language = 'en'

export const parseLanguage = (value: unknown): Language | undefined => LANGUAGES.find(l => l === value)

/** Every text the person sees: the pane, the band, the status line, toasts and notifications, the guards' refusals. */
export type Texts = {
  pane: {
    collecting: string
    worktrees: string
    session: (isRemote: boolean) => string
    notGit: string
    mainCheckout: string
    notPushed: string
    synced: string
    pullRequests: string
    noPrs: string
    thisBranch: string
    processes: string
    noProcesses: string
    status: Record<ProcessStatus, string>
    notListening: string
    background: string
    urls: string
    noUrls: string
    accounts: string
    noPassword: string
    noDocument: string
    documentMissing: string
    documentEmpty: string
    moreLines: (n: number) => string
    fromSession: string
    artifacts: string
    refresh: string
  }
  env: {
    tabTitle: (label: string) => string
    open: string
    notRunning: string
    empty: string
  }
  band: { handsOff: string; local: string }
  statusLine: { processes: (n: number) => string; prs: (n: number) => string; accounts: (n: number) => string }
  notice: {
    deployStarted: (what: string, title: string) => string
    deployDone: (what: string) => string
    deployFailed: (what: string, title: string) => string
    red: (what: string, title: string) => string
    greenMerge: (what: string, title: string) => string
    containersFailing: (what: string, names: string) => string
    down: (what: string) => string
    backUp: (what: string) => string
  }
  setupHint: (command: string) => string
  guard: {
    mainCheckoutWrite: (path: string, mainRoot: string, project: string) => string
    mainCheckoutGit: (sub: string, mainRoot: string, project: string) => string
    migrationTaken: (number: string, where: string, dir: string, next: string) => string
  }
}

const EN: Texts = {
  pane: {
    collecting: 'Collecting the session…',
    worktrees: 'Worktree / branch / remote',
    session: isRemote => `${isRemote ? 'remote (cloud)' : 'local'} session`,
    notGit: 'not a git repository',
    mainCheckout: 'main checkout',
    notPushed: '↑ not pushed',
    synced: '✓ in sync',
    pullRequests: 'Pull requests',
    noPrs: 'no PRs from this session',
    thisBranch: '← this branch',
    processes: 'Processes',
    noProcesses: 'the session started nothing',
    status: { running: 'running', started: 'started', completed: 'finished', failed: 'failed', killed: 'stopped' },
    notListening: 'not listening',
    background: 'background',
    urls: 'URLs',
    noUrls: 'none besides the processes',
    accounts: 'Accounts',
    noPassword: 'no password',
    noDocument: 'no document',
    documentMissing: 'no such document, or it cannot be read',
    documentEmpty: 'the document is empty',
    moreLines: n => `… ${n} more lines in the document`,
    fromSession: 'from this session:',
    artifacts: 'Artifacts',
    refresh: 'Refresh',
  },
  env: {
    tabTitle: label => `🧪 ${label} test data`,
    open: 'open its tab',
    notRunning: 'the environment is off: no test data now',
    empty: 'the document has nothing to show',
  },
  band: { handsOff: 'hands off', local: 'local' },
  statusLine: { processes: n => `${n} proc`, prs: n => `${n} PR`, accounts: n => `${n} ${n === 1 ? 'account' : 'accounts'}` },
  notice: {
    deployStarted: (what, title) => `A merge started ${what} (${title})`,
    deployDone: what => `${what} finished ✓`,
    deployFailed: (what, title) => `${what} FAILED: ${title}`,
    red: (what, title) => `${what} red: ${title}`,
    greenMerge: (what, title) => `Green merge, ${what}: ${title}`,
    containersFailing: (what, names) => `${what} is falling over: ${names}`,
    down: what => `${what} is failing`,
    backUp: what => `${what} ✓ again`,
  },
  setupHint: command => `session-hub: this project has no settings. ${command} sets up the band, the guards and the test data.`,
  guard: {
    mainCheckoutWrite: (path, mainRoot, project) =>
      `session-hub: ${path} is in the main checkout (${mainRoot}). In ${project} work happens in worktrees: enter one (EnterWorktree) and change the file there.`,
    mainCheckoutGit: (sub, mainRoot, project) =>
      `session-hub: \`git ${sub}\` in the main checkout (${mainRoot}). In ${project} work happens in worktrees: enter one (EnterWorktree) or use \`git -C <worktree>\`.`,
    migrationTaken: (number, where, dir, next) =>
      `session-hub: migration number ${number} is already taken: ${where}. The next free number in ${dir}: ${next}.`,
  },
}

/** Polish plural of a count: 1 konto, 2–4 konta, 5+ kont (12–14 kont). */
const plural = (n: number, one: string, few: string, many: string): string => {
  const tens = n % 100
  if (n === 1) return one
  return n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14) ? few : many
}

const PL: Texts = {
  pane: {
    collecting: 'Zbieram dane sesji…',
    worktrees: 'Worktree / branch / remote',
    session: isRemote => `sesja ${isRemote ? 'zdalna (chmura)' : 'lokalna'}`,
    notGit: 'nie repozytorium git',
    mainCheckout: 'główny checkout',
    notPushed: '↑ nie wypchnięty',
    synced: '✓ zsynchronizowany',
    pullRequests: 'Pull requesty',
    noPrs: 'brak PR tej sesji',
    thisBranch: '← ten branch',
    processes: 'Procesy',
    noProcesses: 'sesja nic nie uruchomiła',
    status: { running: 'działa', started: 'uruchomiony', completed: 'zakończony', failed: 'błąd', killed: 'zatrzymany' },
    notListening: 'nie słucha',
    background: 'w tle',
    urls: 'Adresy URL',
    noUrls: 'poza procesami — brak',
    accounts: 'Konta',
    noPassword: 'bez hasła',
    noDocument: 'brak dokumentu',
    documentMissing: 'nie ma takiego dokumentu albo nie da się go odczytać',
    documentEmpty: 'dokument jest pusty',
    moreLines: n => `… jeszcze ${n} ${plural(n, 'wiersz', 'wiersze', 'wierszy')} w dokumencie`,
    fromSession: 'z tej sesji:',
    artifacts: 'Artefakty',
    refresh: 'Odśwież',
  },
  env: {
    tabTitle: label => `🧪 Dane testowe ${label}`,
    open: 'otwórz zakładkę',
    notRunning: 'środowisko nie działa: teraz brak danych testowych',
    empty: 'dokument nie ma nic do pokazania',
  },
  band: { handsOff: 'nie ruszać', local: 'lokalne instancje' },
  statusLine: { processes: n => `${n} proc`, prs: n => `${n} PR`, accounts: n => `${n} ${plural(n, 'konto', 'konta', 'kont')}` },
  notice: {
    deployStarted: (what, title) => `Merge uruchomił ${what} (${title})`,
    deployDone: what => `${what} zakończony ✓`,
    deployFailed: (what, title) => `${what} NIE przeszedł: ${title}`,
    red: (what, title) => `${what} czerwone: ${title}`,
    greenMerge: (what, title) => `Zielony merge, ${what}: ${title}`,
    containersFailing: (what, names) => `${what} się sypie: ${names}`,
    down: what => `${what} nie przechodzi`,
    backUp: what => `${what} znów ✓`,
  },
  setupHint: command => `session-hub: ten projekt nie ma ustawień. ${command} skonfiguruje pasek, strażników i dane testowe.`,
  guard: {
    mainCheckoutWrite: (path, mainRoot, project) =>
      `session-hub: ${path} leży w głównym checkoucie (${mainRoot}). W projekcie ${project} pracuje się w worktree: wejdź do worktree (EnterWorktree) i zmień plik tam.`,
    mainCheckoutGit: (sub, mainRoot, project) =>
      `session-hub: \`git ${sub}\` w głównym checkoucie (${mainRoot}). W projekcie ${project} pracuje się w worktree: wejdź do worktree (EnterWorktree) albo użyj \`git -C <worktree>\`.`,
    migrationTaken: (number, where, dir, next) =>
      `session-hub: numer migracji ${number} jest już zajęty: ${where}. Następny wolny numer w ${dir}: ${next}.`,
  },
}

const TEXTS: Record<Language, Texts> = { en: EN, pl: PL }

export const textsFor = (language: Language): Texts => TEXTS[language]
