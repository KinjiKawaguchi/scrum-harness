import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAlertState } from '../src/alerts/state.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import type { Exec } from '../src/adapters/github/board-writer.ts'
import { runMemberWatch } from '../src/dispatch/run.ts'
import { paths, type Paths } from '../src/store.ts'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import { watchFor } from '../src/watch-role.ts'
import { dispatchPorts, fakePorts } from './fake-ports.ts'
import { snapshot } from './helpers.ts'
import { child, enabled, epic } from './alerts-fixtures.ts'

const options = { maxMs: 300, intervalMs: 10 }
let p: Paths

/** A board copy taken at the current time (so the re-fetch does not call gh). */
const freshBoard = () => ({ ...snapshot([epic(), child(101, { status: 'Next' })]), fetchedAt: new Date().toISOString() })
const idleFor20Minutes = (name: string) =>
  writeHeartbeat(p, { sessionId: `session-${name}`, name, pid: null }, 'idle', new Date(Date.now() - 20 * 60_000))

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-watch-')))
  saveSnapshot(p, freshBoard())
  idleFor20Minutes('SWE2')
})

describe('watchFor', () => {
  it('the liaison returns the message for the liaison when alerts is enabled', async () => {
    const message = await watchFor(p, enabled, 'Liaison', options, fakePorts())
    assert.match(message ?? '', /^scrum-harness: notice for the liaison/)
    assert.match(message ?? '', /- SWE2 has been idle for 20 minutes/)
  })

  it('the liaison waits for nothing when alerts is disabled', async () => {
    assert.equal(await watchFor(p, { ...enabled, alerts: undefined }, 'Liaison', options, fakePorts()), null)
    assert.equal(await watchFor(p, { ...enabled, alerts: { ...enabled.alerts!, enabled: false } }, 'Liaison', options, fakePorts()), null)
  })

  it('a TechLead watch also advances stall detection', async () => {
    await watchFor(p, enabled, 'TechLead', options, fakePorts())
    assert.deepEqual(Object.keys(readAlertState(p).epics), ['app#100'])
  })

  it('a name outside the team waits for nothing; a member waits for nothing when dispatch is disabled or the member is not a hand-over target', async () => {
    assert.equal(await watchFor(p, enabled, 'someone', options, fakePorts()), null)
    assert.equal(await watchFor(p, { ...enabled, dispatch: undefined }, 'SWE2', options, fakePorts()), null)
    const only = { ...enabled, dispatch: { ...enabled.dispatch!, members: ['SWE1'] } }
    assert.equal(await watchFor(p, only, 'SWE2', options, fakePorts()), null)
  })
})

describe('member watch', () => {
  it('a watch that hands over the next work also advances stall detection', async () => {
    const exec: Exec = () => undefined
    const message = await runMemberWatch(p, enabled, 'SWE2', options, dispatchPorts(enabled, exec))
    assert.match(message ?? '', /handed the next work to SWE2/)
    assert.deepEqual(Object.keys(readAlertState(p).epics), ['app#100'])
  })
})
