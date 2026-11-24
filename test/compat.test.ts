import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentRuleName, withAssignee, withConfigAliases } from '../src/compat.ts'
import { loadFetchedSnapshot, loadSnapshot } from '../src/board/snapshot.ts'
import { parseConfig } from '../src/config.ts'
import { lintAll, loadContext } from '../src/findings/lint.ts'
import { loadRecords } from '../src/sprint/record.ts'
import { appendLine, paths, writeJson } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const dir = () => paths(mkdtempSync(join(tmpdir(), 'scrum-compat-')))
/** The saved form of a board item that carries `tanto`. */
const saved = (number: number, name: string | null) => {
  const { assignee: _assignee, ...rest } = issue(number)
  return { ...rest, tanto: name }
}

describe('the alias tanto in the configuration', () => {
  const raw = (fields: object, scripts: object) => ({ ...JSON.parse(JSON.stringify(config)), fields, scripts })
  const fieldsWith = (key: string, value: string) => ({ status: 'Status', reason: 'Reason', since: 'Since', owner: 'Owner', [key]: value })

  it('reads fields.tanto and scripts.setTanto as fields.assignee and scripts.setAssignee', () => {
    const parsed = parseConfig(raw(fieldsWith('tanto', 'Assigned'), { setStatus: 'set-status', setTanto: 'set-assignee' }))
    assert.equal(parsed?.fields.assignee, 'Assigned')
    assert.equal(parsed?.scripts.setAssignee, 'set-assignee')
    assert.equal('tanto' in (parsed?.fields ?? {}), false)
    assert.equal('setTanto' in (parsed?.scripts ?? {}), false)
  })

  it('prefers the current key when both are present', () => {
    const both = { ...fieldsWith('tanto', 'Old'), assignee: 'New' }
    assert.equal(parseConfig(raw(both, { setTanto: 'old', setAssignee: 'new' }))?.fields.assignee, 'New')
    assert.equal(parseConfig(raw(both, { setTanto: 'old', setAssignee: 'new' }))?.scripts.setAssignee, 'new')
  })

  it('leaves a configuration without either key, and a section of the wrong type, as it is', () => {
    assert.equal(parseConfig(raw(fieldsWith('assignee', 'A'), {}))?.fields.assignee, 'A')
    assert.deepEqual(withConfigAliases({ fields: 'x', scripts: null }), { fields: 'x', scripts: null })
  })
})

describe('the alias tanto in saved state', () => {
  it('reads tanto in the saved board copy and in the last fetched copy as assignee', () => {
    const p = dir()
    writeJson(p.snapshot, { ...snapshot([]), items: [saved(1, 'SWE1'), saved(2, null)] })
    writeJson(p.fetchedSnapshot, { ...snapshot([]), items: [saved(3, 'SWE2')] })
    assert.deepEqual(loadSnapshot(p)?.items.map((item) => item.assignee), ['SWE1', null])
    assert.deepEqual(loadFetchedSnapshot(p)?.items.map((item) => item.assignee), ['SWE2'])
    assert.equal('tanto' in (loadSnapshot(p)?.items[0] ?? {}), false)
  })

  it('reads tanto in a checkpoint record as assignee, and keeps the current key when both are present', () => {
    const p = dir()
    const item = { label: 'app#1', points: 3, budget: 2, effort: 1, over: 0, reason: null }
    appendLine(p.checkpoints, JSON.stringify({ scheduledFor: NOW.toISOString(), recordedAt: NOW.toISOString(), items: [{ ...item, tanto: 'SWE1' }, { ...item, tanto: 'old', assignee: 'new' }] }))
    assert.deepEqual(loadRecords(p)[0]?.items.map((one) => one.assignee), ['SWE1', 'new'])
  })

  it('keeps an item that has neither key unchanged', () => {
    const item = { number: 1 }
    assert.equal(withAssignee(item), item)
  })

  it('applies an acknowledgement saved under the former rule name to the current rule', () => {
    const p = dir()
    assert.equal(currentRuleName('B-DOING-NO-TANTO'), 'B-DOING-NO-ASSIGNEE')
    assert.equal(currentRuleName('T-IDLE'), 'T-IDLE')
    const board = snapshot([issue(5, { status: config.statuses.doing })])
    writeJson(p.snapshot, board)
    const until = new Date(NOW.getTime() + 3_600_000).toISOString()
    writeJson(p.acks, [{ rule: 'B-DOING-NO-TANTO', subject: 'app#5', until, reason: 'known', at: NOW.toISOString() }])
    const result = lintAll(loadContext(p, config, NOW, fakePorts().sessions))
    assert.equal(result.active.some((finding) => finding.rule === 'B-DOING-NO-ASSIGNEE'), false)
    assert.equal(result.acked.some((finding) => finding.rule === 'B-DOING-NO-ASSIGNEE'), true)
  })
})
