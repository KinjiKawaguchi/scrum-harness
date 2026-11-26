import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyCommands } from '../src/board/commands.ts'
import { label, lintBoard } from '../src/board/rules.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import type { BoardItem } from '../src/board/types.ts'
import { runRuntime } from '../src/agency-runtime/handle.ts'
import type { TeamView } from '../src/agency-runtime/types.ts'
import { paths } from '../src/store.ts'
import { board as sampleBoard, config as runtimeConfig } from './agency-runtime-board.ts'
import { fakePorts } from './fake-ports.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

/** An item of another tracker: its own id, with the repository and number the board record still has. */
const tracked = (overrides: Partial<BoardItem> = {}): BoardItem => issue(123, { ref: 'ENG-123', repo: 'ENG', status: null, ...overrides })

describe('an item\'s reference', () => {
  it('is `<repo>#<number>` unless the adapter sets one, and the adapter\'s own when it does', () => {
    assert.equal(label(issue(14)), 'app#14')
    assert.equal(label(issue(14, { number: null })), 'app#?')
    assert.equal(label(tracked()), 'ENG-123')
  })

  it('names the item in a finding', () => {
    const findings = lintBoard(snapshot([tracked()]), config, NOW)
    assert.deepEqual(findings.map((one) => [one.rule, one.subject]), [['B-NO-STATUS', 'ENG-123']])
    assert.match(findings[0]?.message ?? '', /^ENG-123 has no Status/)
  })

  it('is the id of a work item and the target of a decision in the team view', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-item-ref-')))
    const blocked = tracked({ title: 'Drop the old export?', status: 'Next', reason: runtimeConfig.reasonJudge, since: '2026-10-07' })
    saveSnapshot(p, { ...sampleBoard(), items: [blocked] })
    const input = JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'view' })
    const output = runRuntime(input, { p, config: runtimeConfig, now: NOW, ports: fakePorts(), spawnRefresh: () => undefined, spawnUsageIndex: () => undefined })
    const view = (JSON.parse(output.stdout) as { result: TeamView }).result
    assert.deepEqual(view.work.map((one) => one.ref), ['ENG-123'])
    const request = view.requests.find((one) => one.kind === 'pendingDecision')
    assert.deepEqual([request?.id, request?.issue, request?.answerWith], ['ENG-123', 'ENG-123', { kind: 'judge', target: 'ENG-123' }])
  })

  it('finds an item again by the label a command names, also when the item is new to the board copy', () => {
    const before = snapshot([tracked({ status: 'Backlog' })])
    const moved = applyCommands(before, [{ kind: 'set-status', label: 'ENG-123', status: 'In Progress' }], config, '2026-10-08')
    assert.deepEqual(moved.items.map((one) => [label(one), one.status]), [['ENG-123', 'In Progress']])
    const added = applyCommands(snapshot([]), [{ kind: 'set-status', label: 'ENG-9', status: 'Backlog' }], config, '2026-10-08')
    assert.deepEqual(added.items.map((one) => label(one)), ['ENG-9'])
  })
})
