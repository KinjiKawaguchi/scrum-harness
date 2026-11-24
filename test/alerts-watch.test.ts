import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAlertState } from '../src/alerts/state.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { runMemberWatch, type Exec } from '../src/dispatch/run.ts'
import { paths, type Paths } from '../src/store.ts'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import { watchFor } from '../src/watch-role.ts'
import { snapshot } from './helpers.ts'
import { child, enabled, epic } from './alerts-fixtures.ts'

const options = { maxMs: 300, intervalMs: 10 }
let p: Paths

/** 現在の時刻で取った控え (取り直しに gh を呼ばせない)。 */
const freshBoard = () => ({ ...snapshot([epic(), child(101, { status: '次にやる' })]), fetchedAt: new Date().toISOString() })
const idleFor20Minutes = (name: string) =>
  writeHeartbeat(p, { sessionId: `session-${name}`, name, pid: null }, 'idle', new Date(Date.now() - 20 * 60_000))

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-watch-')))
  process.env.SCRUM_SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'scrum-sessions-'))
  saveSnapshot(p, freshBoard())
  idleFor20Minutes('SWE2')
})

afterEach(() => {
  delete process.env.SCRUM_SESSIONS_DIR
})

describe('watchFor', () => {
  it('窓口は、alerts が有効なとき、窓口に送る文を返す', async () => {
    const message = await watchFor(p, enabled, 'Liaison', options)
    assert.match(message ?? '', /^scrum-harness: 窓口への通知/)
    assert.match(message ?? '', /- SWE2 が 20 分空いた/)
  })

  it('窓口は、alerts が無効なら何も待たない', async () => {
    assert.equal(await watchFor(p, { ...enabled, alerts: undefined }, 'Liaison', options), null)
    assert.equal(await watchFor(p, { ...enabled, alerts: { ...enabled.alerts!, enabled: false } }, 'Liaison', options), null)
  })

  it('TechLead の待機も、止まりの検知を進める', async () => {
    await watchFor(p, enabled, 'TechLead', options)
    assert.deepEqual(Object.keys(readAlertState(p).epics), ['app#100'])
  })

  it('チームの外の名前は何も待たない。部下は dispatch が無効か、渡す相手でなければ何も待たない', async () => {
    assert.equal(await watchFor(p, enabled, 'だれか', options), null)
    assert.equal(await watchFor(p, { ...enabled, dispatch: undefined }, 'SWE2', options), null)
    const only = { ...enabled, dispatch: { ...enabled.dispatch!, members: ['SWE1'] } }
    assert.equal(await watchFor(p, only, 'SWE2', options), null)
  })
})

describe('部下の待機', () => {
  it('次の仕事を渡す待機も、止まりの検知を進める', async () => {
    const exec: Exec = () => undefined
    const message = await runMemberWatch(p, enabled, 'SWE2', options, exec)
    assert.match(message ?? '', /SWE2 に次の仕事を渡した/)
    assert.deepEqual(Object.keys(readAlertState(p).epics), ['app#100'])
  })
})
