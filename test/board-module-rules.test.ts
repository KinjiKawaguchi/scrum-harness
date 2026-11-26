import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lintBoard } from '../src/board/rules.ts'
import type { BoardItem, Snapshot } from '../src/board/types.ts'
import { config, issue, NOW } from './helpers.ts'

/** The board of a tracker that has no pull requests on it and no list of open issues: items with their own references and nothing GitHub-specific. */
const tracked = (number: number, overrides: Partial<BoardItem> = {}): BoardItem => issue(number, { ref: `ENG-${number}`, repo: 'ENG', ...overrides })
const board = (items: readonly BoardItem[]): Snapshot => ({ fetchedAt: NOW.toISOString(), items, openIssues: [] })

describe('the rules on a board that has nothing GitHub-specific', () => {
  it('raises the board rules, named by the tracker\'s references', () => {
    const findings = lintBoard(board([tracked(1, { status: 'In Progress', assignee: null }), tracked(2, { status: null }), tracked(3, { status: 'Done', state: 'OPEN' })]), config, NOW)
    assert.deepEqual(findings.map((one) => `${one.rule} ${one.subject}`).toSorted(), ['B-DOING-NO-ASSIGNEE ENG-1', 'B-NO-STATUS ENG-2', 'B-OPEN-DONE ENG-3'])
  })

  it('never raises the rules that need pull requests or a list of open issues, and its fixes do not name gh', () => {
    const findings = lintBoard(board([tracked(1, { status: 'In Progress', assignee: null })]), { ...config, scripts: {} }, NOW)
    assert.equal(findings.some((one) => one.rule === 'B-PR-STATUS' || one.rule === 'B-OFF-BOARD'), false)
    assert.equal(findings.some((one) => /\bgh\b/.test(`${one.fix ?? ''}`)), false)
  })
})
