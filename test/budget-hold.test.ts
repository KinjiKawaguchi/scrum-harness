import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../src/adapters/github/board-writer.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { askOwnerWhenOver } from '../src/budget/ask.ts'
import { isHandOverHeld } from '../src/budget/hold.ts'
import { refreshBudget } from '../src/budget/record.ts'
import { dispatchStep } from '../src/dispatch/run.ts'
import { lintAll } from '../src/findings/lint.ts'
import type { BudgetStatus } from '../src/ports/index.ts'
import { readRequests } from '../src/requests/store.ts'
import { paths, writeJson, type Paths } from '../src/store.ts'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import { dispatchPorts, fakePorts } from './fake-ports.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const enabled = { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: [] } }
const status = (state: 'ok' | 'warning' | 'over', extra: Partial<BudgetStatus> = {}): BudgetStatus => ({ weekStart: '2026-11-23', team: { capUsd: 200, spentUsd: 210, state }, org: { capUsd: 500, spentUsd: 311, state: 'ok' }, ...extra })

let p: Paths
let calls: (readonly [string, readonly string[]])[]
const exec: Exec = (script, args) => {
  calls.push([script, args])
}
const keep = (value: BudgetStatus, at: Date = NOW): void => void refreshBudget(fakePorts({ budget: () => value }), p.budget, at)

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-budget-hold-')))
  calls = []
})

describe('holding back new work while the weekly budget is used', () => {
  it('is on only while the kept answer is fresh and says over', () => {
    assert.equal(isHandOverHeld(p.budget, NOW), false)
    keep(status('warning'))
    assert.equal(isHandOverHeld(p.budget, NOW), false)
    keep(status('over'))
    assert.equal(isHandOverHeld(p.budget, NOW), true)
    assert.equal(isHandOverHeld(p.budget, new Date(NOW.getTime() + 181 * 60_000)), false)
    keep(status('ok'))
    assert.equal(isHandOverHeld(p.budget, NOW), false)
  })

  it('hands no board item to an idle member while it is on, and does again when it is not', () => {
    writeHeartbeat(p, { sessionId: 'session-SWE1', name: 'SWE1', pid: null }, 'idle', new Date(NOW.getTime() - 20 * 60_000))
    saveSnapshot(p, snapshot([issue(11, { status: 'Next' })]))
    keep(status('over'))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    assert.equal(calls.length, 0)
    keep(status('ok'))
    assert.match(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec))?.message ?? '', /handed the next work to SWE1/)
    assert.deepEqual(calls.map(([script]) => script), ['set-assignee', 'set-status'])
  })

  it('still nudges a member to move its own work forward', () => {
    writeHeartbeat(p, { sessionId: 'session-SWE1', name: 'SWE1', pid: null }, 'idle', new Date(NOW.getTime() - 40 * 60_000))
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1', title: 'Ongoing job' }), issue(11, { status: 'Next' })]))
    keep(status('over'))
    assert.match(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec, () => null))?.message ?? '', /Continue app#240 Ongoing job/)
  })

  it('does not report an idle member (T-IDLE) while it is on, and does when it is off', () => {
    const idle = [{ name: 'SWE1', state: 'idle' as const, since: new Date(NOW.getTime() - 120 * 60_000).toISOString() }]
    const context = { snapshot: snapshot([]), members: idle, acks: [], config, now: NOW } as unknown as Parameters<typeof lintAll>[0]
    const rules = (budget: BudgetStatus | null): readonly string[] => lintAll({ ...context, budget }).active.map((finding) => finding.rule)
    assert.ok(rules(null).includes('T-IDLE'))
    assert.ok(!rules(status('over')).includes('T-IDLE'))
    assert.ok(rules(status('over')).includes('B-BUDGET-OVER'))
    assert.ok(rules(status('warning')).includes('T-IDLE'))
  })
})

describe('the request for the owner when the weekly budget is used', () => {
  it('files one request for the owner with the spend, what is stopped, and the two ways out', () => {
    const line = askOwnerWhenOver(p, status('over'), NOW)
    assert.match(line ?? '', /^asked the owner about the weekly budget \(request /)
    const [request] = readRequests(p)
    assert.equal(readRequests(p).length, 1)
    assert.deepEqual([request?.title, request?.from, request?.kind, request?.waiting, request?.to], ['The weekly budget is used (until 2026-11-30)', 'harness', 'question', 'owner', undefined])
    assert.match(request?.context ?? '', /team \$210 of \$200; org \$311 of \$500.*no new member is started and no board item is handed to an idle member/)
    assert.deepEqual(request?.options.map((option) => [option.key, option.isRecommended]), [['wait', true], ['raise', undefined]])
  })

  it('files it once per week, again for a new week, and never when the team is not over or the answer is unknown', () => {
    assert.equal(askOwnerWhenOver(p, status('warning'), NOW), null)
    assert.equal(askOwnerWhenOver(p, null, NOW), null)
    assert.notEqual(askOwnerWhenOver(p, status('over'), NOW), null)
    assert.equal(askOwnerWhenOver(p, status('over'), new Date(NOW.getTime() + 3_600_000)), null)
    assert.equal(readRequests(p).length, 1)
    assert.notEqual(askOwnerWhenOver(p, status('over', { weekStart: '2026-11-30' }), NOW), null)
    assert.equal(readRequests(p).length, 2)
  })

  it('does not file it again after the owner closed it in the same week', () => {
    askOwnerWhenOver(p, status('over'), NOW)
    writeJson(join(p.dir, 'unrelated.json'), {})
    assert.equal(askOwnerWhenOver(p, status('over'), NOW), null)
    assert.match(readFileSync(p.budgetAsked, 'utf8'), /"weekStart": "2026-11-23"/)
  })
})
