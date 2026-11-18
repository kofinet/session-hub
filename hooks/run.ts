import type { EngineInterface } from 'claude-code'

/** A host command's stdout when it exits 0, else undefined (a missing tool, an error, a timeout). */
export async function run($: EngineInterface, argv: string[], cwd?: string): Promise<string | undefined> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs: 15_000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}
