import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lintAll } from '../src/findings/lint.ts'
import { readOver, writeOver } from '../src/members/over-threshold.ts'
import { lintOverThreshold } from '../src/members/rules.ts'
import { paths } from '../src/store.ts'
import { config, NOW } from './helpers.ts'

const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()

describe('the finding for a member left on a source past its threshold', () => {
  const records = [
    { name: 'SWE1', source: 'one', since: minutesAgo(95), reason: 'one is past its threshold, and there is no better source (the node says overThreshold)' },
    { name: 'SWE2', source: 'one', since: minutesAgo(5), reason: 'not idle for 60 seconds (busy); left for the next call' },
  ]

  it('is high, names each member, the source, how long, and why', () => {
    const [first, second] = lintOverThreshold(records, NOW)
    assert.deepEqual([first?.rule, first?.subject, first?.severity, first?.minutes], ['M-OVER-THRESHOLD', 'SWE1', 'high', 95])
    assert.match(first?.message ?? '', /^SWE1 still runs on one, which is past its weekly threshold, for 95 minutes: one is past its threshold, and there is no better source/)
    assert.match(second?.message ?? '', /^SWE2 still runs on one, .* for 5 minutes: not idle/)
    assert.match(first?.fix ?? '', /If no source is under its threshold, no member should be running/)
  })

  it('is one finding for each member and stretch (the key has the time the member was first seen), and is nothing without records', () => {
    assert.deepEqual(lintOverThreshold(records, NOW).map((one) => one.key), [`M-OVER-THRESHOLD:SWE1:${records[0]?.since}`, `M-OVER-THRESHOLD:SWE2:${records[1]?.since}`])
    assert.deepEqual(lintOverThreshold([], NOW), [])
  })

  it('reaches the lead through lintAll, from the record the refresh keeps', () => {
    const result = lintAll({ snapshot: null, members: [], acks: [], config, now: NOW, overThreshold: records })
    assert.equal(result.active.filter((one) => one.rule === 'M-OVER-THRESHOLD').length, 2)
  })
})

describe('keeping who is left on a source past its threshold', () => {
  const dir = () => paths(mkdtempSync(join(tmpdir(), 'scrum-over-')))
  const left = (name: string, source = 'one') => ({ name, source, reason: 'no better source' })

  it('keeps the first time a member was seen on a source, drops a member that is not left, and starts again for another source', () => {
    const p = dir()
    writeOver(p.memberOver, [left('SWE1'), left('SWE2')], NOW)
    writeOver(p.memberOver, [left('SWE1'), left('SWE3')], new Date(NOW.getTime() + 600_000))
    assert.deepEqual(readOver(p.memberOver).map((one) => [one.name, one.since]), [['SWE1', NOW.toISOString()], ['SWE3', new Date(NOW.getTime() + 600_000).toISOString()]])
    writeOver(p.memberOver, [left('SWE1', 'two')], new Date(NOW.getTime() + 1_200_000))
    assert.equal(readOver(p.memberOver)[0]?.since, new Date(NOW.getTime() + 1_200_000).toISOString())
  })

  it('with `only`, replaces just that member and leaves the others', () => {
    const p = dir()
    writeOver(p.memberOver, [left('SWE1'), left('SWE2')], NOW)
    writeOver(p.memberOver, [], NOW, 'SWE1')
    assert.deepEqual(readOver(p.memberOver).map((one) => one.name), ['SWE2'])
  })
})
