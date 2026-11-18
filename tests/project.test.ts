import { expect, test } from 'claude-code/testing'

import type { CheckStatus, ProjectStatus } from '../types'
import { cow, cowSays, testCounts } from '../hooks/cow'
import { dockerGroups, numberedFileDirs, workflowFactsOf } from '../hooks/detect'
import { isInMainCheckout, migrationClash, migrationTarget, mutatingGitCalls } from '../hooks/guards'
import { bandGroups, dockerFacts, isCurlOk, newest, notices, ownContainers, parseContainers, repoPath, workflowFacts } from '../hooks/ops'
import type { GhRun } from '../hooks/ops'
import { findProject, parseSettings, withProject } from '../hooks/settings'
import { textsFor } from '../hooks/i18n'

const PL = textsFor('pl').notice
const EN = textsFor('en').notice

const PROJECT = {
  name: 'shop',
  match: { remote: 'acme/shop' },
  checks: [
    { type: 'workflow', label: 'CI', workflow: 'CI', role: 'ci', event: 'push', onSessionBranch: true },
    { type: 'workflow', label: 'deploy', workflow: 'Deploy', role: 'deploy' },
    { type: 'http', label: 'prod', urls: ['https://shop.example/'], accounts: 'docs/test_data_prod.md' },
    { type: 'docker', label: 'dev', containerPrefixes: ['shop-dev-'], url: 'https://app.localhost/', accounts: 'docs/accounts.md' },
    { type: 'busy', label: 'e2e', containerPrefixes: ['shop-lane-'] },
    { type: 'command', label: 'types', command: ['npx', 'tsc', '--noEmit'] },
    { type: 'ftp', label: 'odd' },
  ],
  guards: { mainCheckout: true, migrationDirs: ['db/migrations'] },
}

const SETTINGS = JSON.stringify({ cow: true, sounds: { merge: 'C:\\sounds\\yay.wav' }, projects: [PROJECT, { name: 'broken' }] })

test('settings: checks of every type are parsed; an unknown type and a broken project are reported and left out', async () => {
  const { settings, problems } = parseSettings(SETTINGS)
  expect(problems).toEqual([
    'shop: checks[6] (odd): unknown type ftp (workflow, http, docker, busy, command)',
    'broken: match needs a remote or a path',
  ])
  const shop = settings.projects[0]
  expect(shop?.branch).toBe('main')
  expect(shop?.checks.map(c => c.type)).toEqual(['workflow', 'workflow', 'http', 'docker', 'busy', 'command'])
  expect(shop?.checks[1]).toEqual({ type: 'workflow', label: 'deploy', workflow: 'Deploy', role: 'deploy', onSessionBranch: false })
  expect(shop?.checks[2]).toEqual({ type: 'http', label: 'prod', urls: ['https://shop.example/'], accounts: 'docs/test_data_prod.md' })
  expect(shop?.checks[3]).toEqual({ type: 'docker', label: 'dev', containerPrefixes: ['shop-dev-'], url: 'https://app.localhost/', accounts: 'docs/accounts.md' })
  expect(shop?.checks[5]).toEqual({ type: 'command', label: 'types', command: ['npx', 'tsc', '--noEmit'], everySeconds: 300 })
  expect(findProject(settings, 'https://github.com/acme/shop.git', 'C:/x')?.name).toBe('shop')
  expect(findProject(settings, 'https://github.com/acme/other.git', 'C:/x')).toBeUndefined()
  expect(parseSettings('{').problems).toEqual(['settings.local.json is not valid JSON'])
})

test('settings: saving a project replaces the entry of the same name and keeps the rest of the file', async () => {
  const before = JSON.stringify({ cow: false, projects: [{ name: 'shop', match: { path: 'C:/old' } }, { name: 'blog', match: { path: 'C:/blog' } }] })
  const after = JSON.parse(withProject(before, { name: 'shop', match: { remote: 'acme/shop' } })) as { cow: boolean; projects: { name: string }[] }
  expect(after.cow).toBe(false)
  expect(after.projects).toEqual([
    { name: 'blog', match: { path: 'C:/blog' } },
    { name: 'shop', match: { remote: 'acme/shop' } },
  ])
  expect(JSON.parse(withProject(undefined, { name: 'x' })).projects).toEqual([{ name: 'x' }])
})

const ghRun = (id: number, workflowName: string, status: string, conclusion: string, event = 'push'): GhRun => ({
  databaseId: id,
  workflowName,
  status,
  conclusion,
  headSha: `abcdef${id}`,
  displayTitle: `Merge pull request #${id}`,
  createdAt: '2026-11-13T10:00:00Z',
  event,
})

const check = (over: Partial<CheckStatus> & Pick<CheckStatus, 'key' | 'type' | 'role' | 'state'>): CheckStatus => ({
  label: over.key,
  ...over,
})

const status = (checks: CheckStatus[]): ProjectStatus => ({ name: 'shop', branch: 'main', checks, refreshedAt: 0 })

const CI_OK = check({ key: 'CI', type: 'workflow', role: 'ci', state: 'ok', runId: 1 })
const DEPLOY_OK = check({ key: 'deploy', type: 'workflow', role: 'deploy', state: 'ok', runId: 10 })
const PROD_OK = check({ key: 'prod', type: 'http', role: 'check', state: 'ok' })

test('notices: red CI, a green merge, a deploy start and a production outage; nothing on the first refresh', async () => {
  const before = status([CI_OK, DEPLOY_OK, PROD_OK])
  expect(notices(undefined, before, PL)).toEqual([])
  expect(notices(before, status([{ ...CI_OK, state: 'failed', runId: 2, title: 'Merge pull request #2' }, DEPLOY_OK, PROD_OK]), PL)).toEqual([
    { text: 'CI (shop) czerwone: Merge pull request #2', sound: 'failure' },
  ])
  expect(
    notices(status([{ ...CI_OK, state: 'running', runId: 3 }]), status([{ ...CI_OK, state: 'ok', runId: 3, title: 'x' }]), PL),
  ).toEqual([{ text: 'Zielony merge, CI (shop): x', sound: 'merge' }])
  expect(notices(before, status([CI_OK, { ...DEPLOY_OK, state: 'running', runId: 11, title: 'Merge #11' }, PROD_OK]), PL)).toEqual([
    { text: 'Merge uruchomił deploy (shop) (Merge #11)', sound: 'deploy' },
  ])
  expect(notices(before, status([CI_OK, DEPLOY_OK, { ...PROD_OK, state: 'failed' }]), PL)).toEqual([
    { text: 'prod (shop) nie przechodzi', sound: 'failure' },
  ])
})

test('notices: GitHub coming back after an outage is no green merge, and a green session branch is no merge', async () => {
  expect(notices(status([{ ...CI_OK, state: 'unknown', runId: undefined }]), status([{ ...CI_OK, runId: 5 }]), PL)).toEqual([])
  const own = check({ key: 'CI@feat', label: 'CI feat', type: 'workflow', role: 'ci', state: 'running', runId: 7, isSessionBranch: true })
  expect(notices(status([own]), status([{ ...own, state: 'ok' }]), PL)).toEqual([])
  expect(notices(status([own]), status([{ ...own, state: 'failed', title: 'wip' }]), PL)).toEqual([
    { text: 'CI feat czerwone: wip', sound: 'failure' },
  ])
})

test('notices in English: red CI, a green merge, a deploy start and end, a production outage and its return', async () => {
  const before = status([CI_OK, DEPLOY_OK, PROD_OK])
  expect(notices(before, status([{ ...CI_OK, state: 'failed', runId: 2, title: 'Merge pull request #2' }, DEPLOY_OK, PROD_OK]), EN)).toEqual([
    { text: 'CI (shop) red: Merge pull request #2', sound: 'failure' },
  ])
  expect(notices(status([{ ...CI_OK, state: 'running', runId: 3 }]), status([{ ...CI_OK, state: 'ok', runId: 3, title: 'x' }]), EN)).toEqual([
    { text: 'Green merge, CI (shop): x', sound: 'merge' },
  ])
  expect(notices(before, status([CI_OK, { ...DEPLOY_OK, state: 'running', runId: 11, title: 'Merge #11' }, PROD_OK]), EN)).toEqual([
    { text: 'A merge started deploy (shop) (Merge #11)', sound: 'deploy' },
  ])
  const deploying = status([CI_OK, { ...DEPLOY_OK, state: 'running', runId: 11 }, PROD_OK])
  expect(notices(deploying, status([CI_OK, { ...DEPLOY_OK, state: 'ok', runId: 11 }, PROD_OK]), EN)).toEqual([{ text: 'deploy (shop) finished ✓' }])
  const down = status([CI_OK, DEPLOY_OK, { ...PROD_OK, state: 'failed' }])
  expect(notices(before, down, EN)).toEqual([{ text: 'prod (shop) is failing', sound: 'failure' }])
  expect(notices(down, before, EN)).toEqual([{ text: 'prod (shop) ✓ again' }])
})

test('settings: the interface language is English unless the settings say pl; saving can set it', async () => {
  expect(parseSettings('{"projects": []}').settings.language).toBe('en')
  expect(parseSettings('{"language": "pl", "projects": []}').settings.language).toBe('pl')
  expect(parseSettings('{"language": "de", "projects": []}')).toEqual({
    settings: { version: 1, language: 'en', cow: true, sounds: {}, projects: [] },
    problems: ['language must be one of en, pl'],
  })
  const saved = JSON.parse(withProject('{"cow": false, "projects": []}', { name: 'shop' }, 'pl'))
  expect(saved).toEqual({ cow: false, language: 'pl', projects: [{ name: 'shop' }] })
  expect(JSON.parse(withProject('{"language": "pl", "projects": []}', { name: 'shop' }))).toEqual({ language: 'pl', projects: [{ name: 'shop' }] })
})

test('workflow runs and docker stacks', async () => {
  const runs = [ghRun(3, 'CI', 'completed', 'success', 'pull_request'), ghRun(2, 'CI', 'in_progress', ''), ghRun(1, 'Deploy', 'completed', 'failure')]
  expect(workflowFacts(newest(runs, 'CI', 'push'), false)).toEqual({ state: 'running', detail: 'abcdef2', runId: 2, title: 'Merge pull request #2' })
  expect(workflowFacts(newest(runs, 'Deploy'), false).state).toBe('failed')
  expect(workflowFacts(undefined, false)).toEqual({ state: 'unknown' })

  const containers = parseContainers('shop-dev-api\trunning\tUp 2 hours\nshop-dev-db\trestarting\tRestarting (1)\nshop-lane-1\trunning\tUp\n')
  expect(dockerFacts(ownContainers(containers, ['shop-dev-']), true)).toEqual({ state: 'failed', detail: '1', failing: ['shop-dev-db'] })
  expect(dockerFacts(ownContainers(containers, ['shop-lane-']), undefined)).toEqual({ state: 'ok', detail: '1', failing: [] })
  expect(dockerFacts([], undefined)).toEqual({ state: 'skipped', detail: 'off', failing: [] })
  expect(isCurlOk('<html></html>\n200')).toBe(true)
  expect(isCurlOk('\n502')).toBe(false)
  expect(isCurlOk(undefined)).toBe(false)
})

test('band: local instances are set apart from CI, deploy and production, in the order of the settings', async () => {
  const sim = check({ key: 'sim', type: 'docker', role: 'check', state: 'ok', detail: '11' })
  const e2e = check({ key: 'e2e', type: 'busy', role: 'check', state: 'skipped' })
  const lint = check({ key: 'lint', type: 'command', role: 'check', state: 'ok' })
  expect(bandGroups([CI_OK, sim, DEPLOY_OK, e2e, PROD_OK, lint])).toEqual({ remote: [CI_OK, DEPLOY_OK, PROD_OK, lint], local: [sim, e2e] })
  expect(bandGroups([CI_OK])).toEqual({ remote: [CI_OK], local: [] })
})

test("an instance's accounts doc: a path relative to the repository is joined to its root, an absolute one is kept", async () => {
  expect(repoPath('C:/repo', 'docs/accounts.md')).toBe('C:/repo/docs/accounts.md')
  expect(repoPath('C:/repo', 'docs\\accounts.md')).toBe('C:/repo/docs\\accounts.md')
  expect(repoPath('C:/repo', 'C:/work/shop/docs/ACCOUNTS.md')).toBe('C:/work/shop/docs/ACCOUNTS.md')
  expect(repoPath('C:/repo', 'D:\\shop\\accounts.md')).toBe('D:\\shop\\accounts.md')
  expect(repoPath('/home/me/repo', '/home/me/accounts.md')).toBe('/home/me/accounts.md')
  expect(repoPath('C:/repo', '\\\\server\\share\\accounts.md')).toBe('\\\\server\\share\\accounts.md')
})

test('detection: workflows with their runs, containers by compose project, numbered folders', async () => {
  expect(
    workflowFactsOf(
      JSON.stringify([{ name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }]),
      JSON.stringify([{ workflowName: 'CI', event: 'push', headBranch: 'main', conclusion: 'success' }]),
    ),
  ).toEqual([
    { name: 'CI', path: '.github/workflows/ci.yml', state: 'active', recentRuns: [{ event: 'push', branch: 'main', conclusion: 'success' }] },
  ])
  expect(dockerGroups('shop-dev-api-1\tshop-dev\t0.0.0.0:8080->80/tcp\nshop-dev-db-1\tshop-dev\t\nlonely\t\t')).toEqual([
    { composeProject: 'shop-dev', containers: ['shop-dev-api-1', 'shop-dev-db-1'], ports: ['0.0.0.0:8080->80/tcp'] },
    { composeProject: '', containers: ['lonely'], ports: [] },
  ])
  expect(numberedFileDirs('db/migrations/001_a.sql\ndb/migrations/002_b.sql\ndb/migrations/003_c.sql\ndocs/01_intro.md\nREADME.md')).toEqual([
    { dir: 'db/migrations', count: 3, highest: 3 },
  ])
})

test('guards: the main checkout and its worktrees', async () => {
  const main = 'C:\\repo'
  expect(isInMainCheckout('C:\\repo\\src\\a.ts', main)).toBe(true)
  expect(isInMainCheckout('/c/repo/src/a.ts', main)).toBe(true)
  expect(isInMainCheckout('C:\\repo\\.claude\\worktrees\\x\\src\\a.ts', main)).toBe(false)
  expect(isInMainCheckout('C:\\other\\a.ts', main)).toBe(false)

  expect(mutatingGitCalls('git status && git commit -m "x"', 'C:/repo')).toEqual([{ sub: 'commit', dir: 'c:/repo' }])
  expect(mutatingGitCalls('cd .claude/worktrees/x && git commit -m y', 'C:/repo')).toEqual([
    { sub: 'commit', dir: 'c:/repo/.claude/worktrees/x' },
  ])
  expect(mutatingGitCalls('git -C /c/repo/.claude/worktrees/x checkout -b y', 'C:/repo')).toEqual([
    { sub: 'checkout', dir: 'c:/repo/.claude/worktrees/x' },
  ])
  expect(mutatingGitCalls('git log --oneline; git stash list', 'C:/repo')).toEqual([])
})

test('guards: a migration number another worktree already took', async () => {
  const roots = ['C:/repo', 'C:/repo/.claude/worktrees/a']
  const target = migrationTarget('C:\\repo\\.claude\\worktrees\\a\\db\\migrations\\054_mine.sql', roots, ['db/migrations'])
  expect(target).toEqual({ checkout: 'c:/repo/.claude/worktrees/a', dir: 'db/migrations', name: '054_mine.sql', number: 54, width: 3 })
  expect(migrationTarget('C:\\repo\\src\\054_x.sql', roots, ['db/migrations'])).toBeUndefined()
  if (target === undefined) return

  const clash = migrationClash(target, [
    { where: 'C:/repo', names: ['053_a.sql', 'README.md'] },
    { where: 'C:/repo/.claude/worktrees/b', names: ['053_a.sql', '054_theirs.sql', '055_more.sql'] },
  ])
  expect(clash).toEqual({ taken: [{ where: 'C:/repo/.claude/worktrees/b', name: '054_theirs.sql' }], nextFree: 56 })
  expect(migrationClash(target, [{ where: 'origin/main', names: ['053_a.sql', '054_mine.sql'] }])).toBeUndefined()
})

test('cow: under a red test run and a commit, never under a green run', async () => {
  expect(testCounts('\u001b[31m  1 failed\u001b[0m\n  41 passed (2.1m)')).toEqual({ pass: 41, fail: 1 })
  expect(testCounts('Failed!  - Failed:     2, Passed:    40, Skipped: 0')).toEqual({ pass: 40, fail: 2 })
  expect(cowSays('npx playwright test', true, '  1 failed\n  6 passed')).toEqual({ say: 'Muuu… 1 fail, 6 pass', isRed: true })
  expect(cowSays('npm test', false, ' 7 pass\n 0 fail')).toBeUndefined()
  expect(cowSays('git commit -m x', false, '[main 7318d7b] session-hub 0.3.0\n 5 files changed')).toEqual({
    say: 'Muuu, commit 7318d7b session-hub 0.3.0',
    isRed: false,
  })
  expect(cow('Muuu')[1]).toBe('< Muuu >')
})
