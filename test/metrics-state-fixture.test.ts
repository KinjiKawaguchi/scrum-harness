import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ParticipantMetrics } from '../src/agency-runtime/types.ts'
import { writeMetricsState } from './fixtures/metrics-state.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/metrics-state.ts', import.meta.url))

/** What the node does: the request on the standard input of `scrum runtime`, the state directory in the environment, one JSON line out. */
function ask(dir: string, request: object): { readonly status: number | null; readonly body: { result?: unknown; error?: { status: number } } } {
  const env = { ...process.env, SCRUM_STATE_DIR: dir, SCRUM_NAME: '' }
  const run = spawnSync('node', ['--no-warnings', CLI, 'runtime'], { input: JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', ...request }), env, encoding: 'utf8' })
  return { status: run.status, body: JSON.parse(run.stdout) as { result?: unknown; error?: { status: number } } }
}

describe('the state directory made for a check of participantMetrics from a node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-metrics-state-'))
  writeMetricsState(dir, { repo: 'acme/app', pullRequests: [{ number: 12, by: 'SWE1' }, { number: 13, by: 'SWE2' }] })

  it('is described as having the op', () => {
    const { status, body } = ask(dir, { op: 'describe' })
    assert.equal(status, 0)
    assert.equal((body.result as { ops: string[] }).ops.includes('participantMetrics'), true)
  })

  it('answers with the days cut at the offset asked for, the times of the members, their tokens, and the pull requests with their authors', () => {
    const { status, body } = ask(dir, { op: 'participantMetrics', days: 14, utcOffsetMinutes: 540 })
    assert.equal(status, 0)
    const report = body.result as ParticipantMetrics
    assert.deepEqual([report.org, report.team, report.days, report.utcOffsetMinutes], ['acme', 'app', 14, 540])
    assert.deepEqual(report.participants.map((one) => one.name), ['SWE1', 'SWE2'])
    for (const one of report.participants) {
      const total = (pick: (day: (typeof one.byDay)[number]) => number): number => one.byDay.reduce((sum, day) => sum + pick(day), 0)
      // two shifts of two busy hours, half an hour waiting, an hour and a half idle
      assert.equal(total((day) => day.busySeconds), 4 * 3600)
      assert.equal(total((day) => day.waitingSeconds), 3600)
      assert.equal(total((day) => day.idleSeconds), 3 * 3600)
      assert.equal(total((day) => day.tokens.input), 4_000_000)
      assert.ok(one.byDay.every((day) => day.busySeconds + day.waitingSeconds + day.idleSeconds <= 86_400))
    }
    assert.deepEqual(report.pullRequests.toSorted((a, b) => a.number - b.number), [{ repo: 'acme/app', number: 12, by: 'SWE1' }, { repo: 'acme/app', number: 13, by: 'SWE2' }])
  })

  it('uses the time zone of its own configuration when the node gives none, and is refused an offset that is not a time zone', () => {
    const report = ask(dir, { op: 'participantMetrics', days: 3 }).body.result as ParticipantMetrics
    assert.equal(report.utcOffsetMinutes, 540)
    const refused = ask(dir, { op: 'participantMetrics', days: 3, utcOffsetMinutes: 900 })
    assert.deepEqual([refused.status, refused.body.error?.status], [1, 400])
  })

  it('can be made by the command line, with the pull requests named on it', () => {
    const made = mkdtempSync(join(tmpdir(), 'scrum-metrics-state-cli-'))
    const run = spawnSync('node', ['--no-warnings', FIXTURE, '--dir', made, '--repo', 'acme/other', '--pr', '7:SWE2'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const report = ask(made, { op: 'participantMetrics', days: 3, utcOffsetMinutes: 0 }).body.result as ParticipantMetrics
    assert.deepEqual(report.pullRequests, [{ repo: 'acme/other', number: 7, by: 'SWE2' }])
  })
})
