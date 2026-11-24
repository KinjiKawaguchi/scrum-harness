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

/** 現在の時刻で取った控え (取り直しに gh を呼ばせない)。 */
const freshBoard = () => ({ ...snapshot([epic(), child(101, { status: 'Next' })]), fetchedAt: new Date().toISOString() })
const idleFor20Minutes = (name: string) =>
  writeHeartbeat(p, { sessionId: `session-${name}`, name, pid: null }, 'idle', new Date(Date.now() - 20 * 60_000))

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-watch-')))
  saveSnapshot(p, freshBoard())
  idleFor20Minutes('SWE2')
})

describe('watchFor', () => {
  it('窓口は、alerts が有効なとき、窓口に送る文を返す', async () => {
    const message = await watchFor(p, enabled, 'Liaison', options, fakePorts())
    assert.match(message ?? '', /^scrum-harness: notice for the liaison/)
    assert.match(message ?? '', /- SWE2 has been idle for 20 minutes/)
  })

  it('窓口は、alerts が無効なら何も待たない', async () => {
    assert.equal(await watchFor(p, { ...enabled, alerts: undefined }, 'Liaison', options, fakePorts()), null)
    assert.equal(await watchFor(p, { ...enabled, alerts: { ...enabled.alerts!, enabled: false } }, 'Liaison', options, fakePorts()), null)
  })

  it('TechLead の待機も、止まりの検知を進める', async () => {
    await watchFor(p, enabled, 'TechLead', options, fakePorts())
    assert.deepEqual(Object.keys(readAlertState(p).epics), ['app#100'])
  })

  it('チームの外の名前は何も待たない。部下は dispatch が無効か、渡す相手でなければ何も待たない', async () => {
    assert.equal(await watchFor(p, enabled, 'someone', options, fakePorts()), null)
    assert.equal(await watchFor(p, { ...enabled, dispatch: undefined }, 'SWE2', options, fakePorts()), null)
    const only = { ...enabled, dispatch: { ...enabled.dispatch!, members: ['SWE1'] } }
    assert.equal(await watchFor(p, only, 'SWE2', options, fakePorts()), null)
  })
})

describe('部下の待機', () => {
  it('次の仕事を渡す待機も、止まりの検知を進める', async () => {
    const exec: Exec = () => undefined
    const message = await runMemberWatch(p, enabled, 'SWE2', options, dispatchPorts(enabled, exec))
    assert.match(message ?? '', /handed the next work to SWE2/)
    assert.deepEqual(Object.keys(readAlertState(p).epics), ['app#100'])
  })
})
