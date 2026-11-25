import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alertsCommand } from '../src/alerts/command.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { gh } from '../src/adapters/github/gh.ts'
import { projectBoardSource } from '../src/adapters/github/project-board.ts'
import type { Snapshot } from '../src/board/types.ts'
import { paths } from '../src/store.ts'
import { config, NOW, snapshot } from './helpers.ts'
import { child, enabled, epic } from './alerts-fixtures.ts'
import { fakePorts } from './fake-ports.ts'

/** A port whose re-fetch is replaced by the given function. The function returns the re-fetched board copy. */
const refreshing = (fetchSnapshot: () => Snapshot) => fakePorts({ board: { ...fakePorts().board, fetchSnapshot } })

describe('alertsCommand (scrum alerts)', () => {
  it('does nothing and returns the reason when alerts is not enabled', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-cmd-')))
    assert.match(alertsCommand(p, config, NOW, fakePorts()), /alerts is not enabled/)
  })

  it('when enabled, advances detection once, sends the desktop notification if not yet sent, and returns the number of Epics nobody is working on and of members with no issue to hand over', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-cmd-')))
    const board = { ...snapshot([epic(), child(101, { status: 'Next' })]), fetchedAt: NOW.toISOString() }
    saveSnapshot(p, board)
    const sent: string[] = []
    const notify = (_title: string, body: string) => sent.push(body)
    assert.equal(alertsCommand(p, enabled, NOW, fakePorts({ notify })), 'Advanced the stall detection. Epics with nobody moving: 1; members with nothing to hand over: 0')
    assert.equal(sent.length, 0)
    alertsCommand(p, enabled, new Date(NOW.getTime() + 60 * 60_000), fakePorts({ notify }))
    assert.equal(sent.length, 1)
  })
})

describe('alertsCommand board copy refresh', () => {
  const stale = (p: ReturnType<typeof paths>) => saveSnapshot(p, { ...snapshot([epic(), child(101, { status: 'Next' })]), fetchedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString() })

  it('refreshes a stale board copy before detection (on a night when only the scheduled run refreshes it)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-refresh-')))
    stale(p)
    const order: string[] = []
    alertsCommand(
      p,
      enabled,
      NOW,
      refreshing(() => {
        order.push('refresh')
        throw new Error('the retry was only attempted')
      }),
    )
    assert.deepEqual(order, ['refresh'])
  })

  it('does not refresh a fresh board copy', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-refresh-')))
    saveSnapshot(p, { ...snapshot([epic()]), fetchedAt: NOW.toISOString() })
    let called = false
    alertsCommand(
      p,
      enabled,
      NOW,
      refreshing(() => {
        called = true
        throw new Error('not called')
      }),
    )
    assert.equal(called, false)
  })

  it('detects with the board copy obtained by the refresh (if the refresh makes the copy fresh, that copy is used)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-refresh-')))
    stale(p)
    const refreshed = { ...snapshot([epic(), child(101, { status: 'Next' })]), fetchedAt: NOW.toISOString() }
    const text = alertsCommand(p, enabled, NOW, refreshing(() => refreshed))
    assert.match(text, /Epics with nobody moving: 1/)
  })

  it('the real refresh writes the attempt time before calling gh (so it does not hit gh every 5 minutes when gh is unusable)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-refresh-')))
    stale(p)
    const savedPath = process.env.PATH
    process.env.PATH = mkdtempSync(join(tmpdir(), 'scrum-no-gh-'))
    try {
      alertsCommand(p, enabled, NOW, fakePorts({ board: projectBoardSource(gh, enabled) }))
    } finally {
      process.env.PATH = savedPath
    }
    assert.equal(readFileSync(p.refreshAttempt, 'utf8').includes(NOW.toISOString()), true)
  })
})
