import { expect, test } from 'claude-code/testing'

import { argsOf, commandName, runText, simpleCommands } from '../hooks/shell'

const names = (command: string, shell: 'bash' | 'powershell' = 'bash') => simpleCommands(command, shell).map(commandName)

test('commands are split at ; & | && || brackets and line breaks', async () => {
  expect(names('cd app && npm ci || exit 1; ls | wc -l & echo done\n(git status)')).toEqual(['cd', 'npm', 'exit', 'ls', 'wc', 'echo', 'git'])
})

test('heredoc bodies are carried, not run: quoted, bare, <<- with tabs, two on one line', async () => {
  expect(names("cat > a <<'EOF'\nnpm run dev\nEOF\nnode x.js")).toEqual(['cat', 'node'])
  expect(names('cat > a <<EOF\ndocker run x\nEOF')).toEqual(['cat'])
  expect(names('cat <<-END\n\tvite\n\tEND\nls')).toEqual(['cat', 'ls'])
  expect(names("paste <<A <<'B'\nnpm start\nA\nvite\nB\npwd")).toEqual(['paste', 'pwd'])
  expect(names("python -I - <<'PYEOF'\nprint('x')\nPYEOF")).toEqual(['python'])
  expect(names("cat <<'EOF'\nnever closed\nnpm start")).toEqual(['cat'])
})

test('a PowerShell here-string is carried, not run, with either line ending', async () => {
  expect(names("$doc = @'\nnpm start\n'@\nSet-Content x.md $doc", 'powershell')).toEqual(['$doc', 'set-content'])
  expect(names('$doc = @"\r\nvite\r\n"@\r\nWrite-Output $doc', 'powershell')).toEqual(['$doc', 'write-output'])
})

test('quotes are removed from words and marked; a quoted command is no command', async () => {
  const [commit] = simpleCommands('git commit -m "start it: npm run dev" --author=\'A B\'')
  expect(commit === undefined ? [] : argsOf(commit)).toEqual([
    { text: 'commit', isQuoted: false },
    { text: '-m', isQuoted: false },
    { text: 'start it: npm run dev', isQuoted: true },
    { text: '--author=A B', isQuoted: true },
  ])
  expect(names('"npm" start')).toEqual([''])
})

test('the command name comes after assignments and prefixes, without its folder, in small letters', async () => {
  expect(names('PORT=3000 NODE_ENV=dev node server.js')).toEqual(['node'])
  expect(names('sudo nohup /usr/bin/Docker run x')).toEqual(['docker'])
  expect(names('.\\start-dev.ps1', 'powershell')).toEqual(['start-dev.ps1'])
})

test('comments are left out, but #12 is a word', async () => {
  expect(runText('npm run dev # http://localhost:5173\ngh pr merge #12')).toBe('npm run dev ; gh pr merge #12')
})

test('a backslash escapes in Bash and is a path in PowerShell', async () => {
  expect(runText('echo a\\ b \\\nc')).toBe('echo a b c')
  expect(runText('git worktree add C:\\w\\x', 'powershell')).toBe('git worktree add C:\\w\\x')
})
