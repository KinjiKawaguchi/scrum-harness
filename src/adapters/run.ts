import { spawnSync } from 'node:child_process'

/** Runs a program with an argument list (never a shell line). Tests pass a fake that records the calls. */
export type Run = (command: string, args: readonly string[]) => { readonly status: number | null; readonly stdout: string; readonly stderr: string }

const TIMEOUT_MS = 30_000

export const realRun: Run = (command, args) => {
  const run = spawnSync(command, [...args], { encoding: 'utf8', timeout: TIMEOUT_MS })
  return { status: run.error === undefined ? run.status : null, stdout: run.stdout ?? '', stderr: run.stderr ?? run.error?.message ?? '' }
}

/** Runs and throws with the program's own message when it fails. */
export function runOrThrow(run: Run, command: string, args: readonly string[]): string {
  const result = run(command, args)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  return result.stdout
}
