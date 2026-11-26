import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvents, eventId, eventsSince, readEvents, RETENTION_MS, trimLog } from '../src/activity/log.ts'
import type { ActivityEvent } from '../src/activity/types.ts'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import type { Activity } from '../src/agency-runtime/types.ts'
import { paths, type Paths } from '../src/store.ts'
import { config } from './agency-runtime-board.ts'
import { fakePorts } from './fake-ports.ts'
import { NOW } from './helpers.ts'

let p: Paths
let refreshes: number
let indexReads: number

const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const added = (ref: string, minutes: number): ActivityEvent => ({ id: eventId('b', 'itemAdded', ref, minutesAgo(minutes)), at: minutesAgo(minutes), kind: 'itemAdded', ref, title: `Title of ${ref}` })
const message = (from: string, to: string, minutes: number, summary = 'Asks for a review'): ActivityEvent => ({ id: eventId('m', from, to, String(minutes)), at: minutesAgo(minutes), kind: 'message', from, to, summary })

const deps = (): RuntimeDeps => ({ p, config, now: NOW, ports: fakePorts(), spawnRefresh: () => void (refreshes += 1), spawnUsageIndex: () => void (indexReads += 1) })
const ask = (extra: object = {}) => {
  const input = JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'activity', since: minutesAgo(60), limit: 100, ...extra })
  const output = runRuntime(input, deps())
  return { exitCode: output.exitCode, response: JSON.parse(output.stdout) as { result?: Activity; error?: { status: number; message: string } } }
}

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-activity-')))
  mkdirSync(join(p.dir, 'cache'), { recursive: true })
  refreshes = 0
  indexReads = 0
})

describe('the activity log', () => {
  it('gives an event the same id every time, and different ids for different events', () => {
    assert.equal(eventId('b', 'prMerged', 'app#9', 'T'), eventId('b', 'prMerged', 'app#9', 'T'))
    assert.notEqual(eventId('b', 'prMerged', 'app#9', 'T'), eventId('b', 'prOpened', 'app#9', 'T'))
    assert.match(eventId('m', 'a', 'b'), /^m-[0-9a-f]{12}$/)
  })

  it('keeps an event once however often it is appended, oldest first', () => {
    const events = [added('app#2', 10), added('app#1', 20)]
    assert.equal(appendEvents(p.activityLog, events, NOW), 2)
    assert.equal(appendEvents(p.activityLog, [...events, added('app#3', 5)], NOW), 1)
    assert.deepEqual(readEvents(p.activityLog).map((one) => (one.kind === 'itemAdded' ? one.ref : '')), ['app#1', 'app#2', 'app#3'])
  })

  it('does not keep an event older than 24 hours', () => {
    assert.equal(appendEvents(p.activityLog, [added('app#1', RETENTION_MS / 60_000 + 5), added('app#2', 5)], NOW), 1)
  })

  it('drops a line that cannot be read, and an event without a valid time', () => {
    writeFileSync(p.activityLog, `not json\n${JSON.stringify({ id: 'x', kind: 'itemAdded', at: 'never' })}\n${JSON.stringify(added('app#1', 5))}\n`)
    assert.equal(readEvents(p.activityLog).length, 1)
  })

  it('answers the first `limit` events strictly after `since`, and says when more remain', () => {
    const events = [added('app#1', 50), added('app#2', 40), added('app#3', 30), added('app#4', 20)]
    const since = new Date(NOW.getTime() - 40 * 60_000)
    const first = eventsSince(events, since, 2, NOW)
    assert.deepEqual([first.events.map((one) => (one.kind === 'itemAdded' ? one.ref : '')), first.truncated], [['app#3', 'app#4'], false])
    const cut = eventsSince(events, new Date(0), 2, NOW)
    assert.deepEqual([cut.events.length, cut.truncated], [2, true])
  })

  it('does not answer from before the retention window, whatever `since` says', () => {
    assert.equal(eventsSince([added('app#1', RETENTION_MS / 60_000 + 30)], new Date(0), 10, NOW).events.length, 0)
  })

  it('rewrites a log that has grown, keeping what is still in the window', () => {
    const old = JSON.stringify(added('app#0', RETENTION_MS / 60_000 + 60))
    writeFileSync(p.activityLog, `${Array.from({ length: 5001 }, () => old).join('\n')}\n${JSON.stringify(added('app#1', 5))}\n`)
    trimLog(p.activityLog, NOW)
    assert.equal(readFileSync(p.activityLog, 'utf8').split('\n').filter((line) => line !== '').length, 1)
  })
})

describe('agency-runtime/1 activity', () => {
  it('answers the events after `since`, oldest first, with the time it was generated', () => {
    appendEvents(p.activityLog, [added('app#2', 10), message('TechLead', 'SWE1', 30), added('app#1', 90)], NOW)
    const { exitCode, response } = ask()
    assert.equal(exitCode, 0)
    assert.deepEqual([response.result?.org, response.result?.team, response.result?.generatedAt, response.result?.truncated], ['acme', 'app', NOW.toISOString(), false])
    assert.deepEqual(response.result?.events.map((one) => one.kind), ['message', 'itemAdded'])
  })

  it('answers an empty list, not an error, when the log is empty', () => {
    assert.deepEqual(ask().response, { result: { org: 'acme', team: 'app', generatedAt: NOW.toISOString(), events: [], truncated: false } })
  })

  it('cuts at `limit` and says so', () => {
    appendEvents(p.activityLog, [added('app#1', 30), added('app#2', 20), added('app#3', 10)], NOW)
    const { response } = ask({ limit: 2 })
    assert.deepEqual([response.result?.events.length, response.result?.truncated], [2, true])
  })

  it('reads only the log: it never creates one, and starts the board refresh and the transcript reader when they are due', () => {
    ask()
    assert.equal(existsSync(p.activityLog), false)
    assert.deepEqual([refreshes, indexReads], [1, 1])
  })

  const malformed: readonly (readonly [string, object])[] = [
    ['a missing since', { since: undefined }],
    ['a since that is not a time', { since: 'yesterday' }],
    ['a since without the Z', { since: '2026-11-24T12:00:00' }],
    ['a limit of 0', { limit: 0 }],
    ['a limit above 500', { limit: 501 }],
    ['a limit that is not whole', { limit: 1.5 }],
    ['a limit that is text', { limit: '10' }],
  ]
  for (const [name, extra] of malformed) {
    it(`refuses ${name} (400)`, () => {
      assert.equal(ask(extra).response.error?.status, 400)
    })
  }
})
