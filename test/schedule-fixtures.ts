import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Run } from '../src/adapters/run.ts'
import type { ScheduleSetup } from '../src/ports/index.ts'
import { ALERTS_JOB } from '../src/schedule/command.ts'

export const JOB = ALERTS_JOB

/** The values of a machine, with a home folder that is a throwaway directory so that nothing real is written. */
export function setupIn(overrides: Partial<ScheduleSetup> = {}): ScheduleSetup {
  const home = mkdtempSync(join(tmpdir(), 'scrum-schedule-home-'))
  return { home, scrumDir: '/opt/scrum-harness', path: '/usr/local/bin:/usr/bin:/bin', stateDir: join(home, '.claude', 'scrum'), isCustomStateDir: false, instance: '', ...overrides }
}

export type Call = readonly [string, ...string[]]

/** A Run that records each call and answers with the given status (0 unless a call is listed as failing). */
export function recordingRun(failing: readonly string[] = [], stdout: Record<string, string> = {}): { readonly run: Run; readonly calls: Call[] } {
  const calls: Call[] = []
  const run: Run = (command, args) => {
    const call = [command, ...args] as unknown as Call
    calls.push(call)
    const key = call.join(' ')
    const isFailing = failing.some((part) => key.includes(part))
    return { status: isFailing ? 1 : 0, stdout: Object.entries(stdout).find(([part]) => key.includes(part))?.[1] ?? '', stderr: isFailing ? 'failed on purpose' : '' }
  }
  return { run, calls }
}
