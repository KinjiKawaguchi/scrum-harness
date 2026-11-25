import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseName, identityNames, membersBySession, sessionNames, teamFiles } from '../src/usage/attribution.ts'
import { EMPTY_INDEX, type CompactRow, type UsageIndex } from '../src/usage/index-store.ts'
import { costOf, priceOf, roundToCents } from '../src/usage/pricing.ts'
import { lastDates, summarize } from '../src/usage/summary.ts'
import { paths } from '../src/store.ts'
import { fileOf, sourceOf, ZERO, SESSION_A, SESSION_B, SESSION_OTHER } from './usage-fixtures.ts'

const MILLION = { input: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 1_000_000, output: 100_000 }

describe('pricing', () => {
  it('prices every kind of token, cache writes at 1.25 and 2 times the input price', () => {
    // 4 (input) + 5 (5-minute write) + 8 (1-hour write) + 0.2 (read) + 2 (output)
    assert.equal(roundToCents(costOf('claude-opus-5-5', MILLION, false)), 19.2)
  })

  it('doubles the price in fast mode', () => {
    assert.equal(roundToCents(costOf('claude-opus-5-5', MILLION, true)), 38.4)
  })

  it('prices a model by the newest pattern that matches it', () => {
    assert.deepEqual([priceOf('claude-fable-5-2').input, priceOf('claude-fable-5-1-20260101').input, priceOf('claude-fable-5').input], [8, 10, 10])
    assert.deepEqual([priceOf('claude-opus-5-5').input, priceOf('claude-opus-5').input, priceOf('claude-opus-4-1').input], [4, 5, 15])
    assert.deepEqual([priceOf('claude-sonnet-5-5-x').cacheRead, priceOf('claude-sonnet-5').cacheRead], [0.1, 0.2])
  })

  it('prices a model it does not know as the default model', () => {
    assert.deepEqual(priceOf('some-other-model'), priceOf('claude-opus-5-5'))
  })

  it('costs nothing for no tokens', () => {
    assert.equal(costOf('claude-opus-5-5', ZERO, false), 0)
  })

  it('rounds to cents', () => {
    assert.deepEqual([roundToCents(0.004), roundToCents(0.005), roundToCents(1.239)], [0, 0.01, 1.24])
  })
})

const MINUTE = 60_000
const minuteOf = (iso: string) => Date.parse(iso) / MINUTE
/** A row of 1M input tokens of the default model: $4 */
const row = (session: number, iso: string, input = 1_000_000, fast = 0): CompactRow => [session, minuteOf(iso), 0, fast, input, 0, 0, 0, 0]
const indexOf = (rows: readonly CompactRow[]): UsageIndex => ({ ...EMPTY_INDEX, sessionIds: [SESSION_A, SESSION_B, SESSION_OTHER], models: ['claude-opus-5-5'], rows })
const members = new Map([[SESSION_A, 'SWE1'], [SESSION_B, 'SWE2']])
const NOW = new Date('2026-11-24T12:00:00.000Z')
const base = { memberOf: members, now: NOW, offsetMinutes: 0 }

describe('the days of a usage report', () => {
  it('lists the last N calendar days, oldest first and today last', () => {
    assert.deepEqual(lastDates(3, NOW, 0), ['2026-11-22', '2026-11-23', '2026-11-24'])
    assert.deepEqual(lastDates(1, NOW, 0), ['2026-11-24'])
  })

  it('cuts the days in the given time zone', () => {
    assert.deepEqual(lastDates(2, new Date('2026-11-24T20:00:00.000Z'), 9 * 60), ['2026-11-24', '2026-11-25'])
    assert.deepEqual(lastDates(2, new Date('2026-11-24T02:00:00.000Z'), -5 * 60), ['2026-11-22', '2026-11-23'])
  })

  it('crosses month and year boundaries', () => {
    assert.deepEqual(lastDates(3, new Date('2027-01-01T12:00:00.000Z'), 0), ['2026-12-30', '2026-12-31', '2027-01-01'])
  })
})

describe('summarizing usage', () => {
  it('sums cost per person per day, with a day that has no usage kept and empty', () => {
    const index = indexOf([row(0, '2026-11-24T10:00:00Z'), row(0, '2026-11-24T11:00:00Z'), row(1, '2026-11-24T11:00:00Z'), row(0, '2026-11-22T11:00:00Z')])
    const { byDay } = summarize({ ...base, index, days: 3 })
    assert.deepEqual(byDay, [
      { date: '2026-11-22', costUsd: { SWE1: 4 } },
      { date: '2026-11-23', costUsd: {} },
      { date: '2026-11-24', costUsd: { SWE1: 8, SWE2: 4 } },
    ])
  })

  it('leaves out usage outside the window, in the future, and by sessions that are not the team', () => {
    const index = indexOf([row(0, '2026-11-21T23:59:00Z'), row(0, '2026-11-24T12:01:00Z'), row(2, '2026-11-24T10:00:00Z'), row(0, '2026-11-24T10:00:00Z')])
    const { byDay, byPerson } = summarize({ ...base, index, days: 3 })
    assert.deepEqual(byDay.map((day) => day.costUsd), [{}, {}, { SWE1: 4 }])
    assert.deepEqual(byPerson.map((one) => one.person), ['SWE1'])
  })

  it('cuts days in the time zone: 20:00 UTC is the next day at +09:00', () => {
    const index = indexOf([row(0, '2026-11-24T20:00:00Z')])
    const now = new Date('2026-11-24T21:00:00.000Z')
    const { byDay } = summarize({ ...base, index, now, days: 2, offsetMinutes: 540 })
    assert.deepEqual(byDay, [{ date: '2026-11-24', costUsd: {} }, { date: '2026-11-25', costUsd: { SWE1: 4 } }])
  })

  it('totals tokens per person, with both cache writes as one, ranked by cost', () => {
    const full: CompactRow = [1, minuteOf('2026-11-24T10:00:00Z'), 0, 0, 10, 20, 30, 40, 50]
    const index = indexOf([full, row(0, '2026-11-24T10:00:00Z'), full])
    const { byPerson } = summarize({ ...base, index, days: 1 })
    assert.deepEqual(byPerson, [
      { person: 'SWE1', costUsd: 4, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { person: 'SWE2', costUsd: 0, tokens: { input: 20, output: 100, cacheRead: 80, cacheWrite: 100 } },
    ])
  })

  it('rounds each cost to cents from the unrounded sum', () => {
    const index = indexOf([row(0, '2026-11-24T10:00:00Z', 1_000), row(0, '2026-11-24T10:01:00Z', 1_000), row(0, '2026-11-24T10:02:00Z', 1_000)])
    const { byDay, byPerson } = summarize({ ...base, index, days: 1 })
    assert.deepEqual([byDay[0]?.costUsd.SWE1, byPerson[0]?.costUsd], [0.01, 0.01])
  })

  it('prices fast mode and each model on its own', () => {
    const index: UsageIndex = { ...indexOf([row(0, '2026-11-24T10:00:00Z', 1_000_000, 1), [0, minuteOf('2026-11-24T11:00:00Z'), 1, 0, 1_000_000, 0, 0, 0, 0]]), models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }
    assert.equal(summarize({ ...base, index, days: 1 }).byPerson[0]?.costUsd, 10)
  })

  it('reports nothing for an empty index', () => {
    assert.deepEqual(summarize({ ...base, index: EMPTY_INDEX, days: 2 }), { byDay: [{ date: '2026-11-23', costUsd: {} }, { date: '2026-11-24', costUsd: {} }], byPerson: [] })
  })
})

describe('attributing sessions to the team', () => {
  it('drops the number added when a second session takes the same name', () => {
    assert.deepEqual([baseName('SWE1 (2)'), baseName('SWE1'), baseName('SWE (x)')], ['SWE1', 'SWE1', 'SWE (x)'])
  })

  const team = new Set(['SWE1', 'SWE2'])

  it('reads only the project folders that hold a session of the team', () => {
    const files = [fileOf('/a/1', SESSION_A, 1, 'p1'), fileOf('/a/2', SESSION_A, 1, 'p1', true), fileOf('/b/1', SESSION_OTHER, 1, 'p2'), fileOf('/c/1', SESSION_B, 1, 'p3')]
    const names = new Map([[SESSION_A, 'SWE1'], [SESSION_B, 'Reviewer'], [SESSION_OTHER, 'someone']])
    assert.deepEqual(teamFiles(files, names, team).map((file) => file.path), ['/a/1', '/a/2'])
  })

  it('does not take a project because of a subagent alone', () => {
    const files = [fileOf('/a/1', SESSION_A, 1, 'p1', true)]
    assert.deepEqual(teamFiles(files, new Map([[SESSION_A, 'SWE1']]), team), [])
  })

  it('takes the name from the records first and from the title in the transcript last', () => {
    const index: UsageIndex = { ...EMPTY_INDEX, sessionIds: [SESSION_A, SESSION_B, SESSION_OTHER], titles: { [SESSION_A]: 'SWE2', [SESSION_B]: 'SWE2 (2)', [SESSION_OTHER]: 'outsider' } }
    const names = new Map([[SESSION_A, 'SWE1']])
    assert.deepEqual([...membersBySession(index, names, team)].toSorted(), [[SESSION_A, 'SWE1'], [SESSION_B, 'SWE2']])
  })

  it('prefers the hooks identity record over the agent product record', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-usage-names-')))
    mkdirSync(p.identity, { recursive: true })
    writeFileSync(join(p.identity, `${SESSION_A}.json`), JSON.stringify({ name: 'SWE1', pid: 1 }))
    writeFileSync(join(p.identity, 'broken.json'), '{')
    writeFileSync(join(p.identity, `${SESSION_B}.json`), JSON.stringify({ name: null }))
    assert.deepEqual([...identityNames(p)], [[SESSION_A, 'SWE1']])
    const source = sourceOf([], new Map([[SESSION_A, 'renamed'], [SESSION_B, 'SWE2']]))
    assert.deepEqual([...sessionNames(p, source)].toSorted(), [[SESSION_A, 'SWE1'], [SESSION_B, 'SWE2']])
  })

  it('reads no names from a state directory that has no identity folder', () => {
    assert.equal(identityNames(paths(join(tmpdir(), 'scrum-usage-none-xyz'))).size, 0)
  })
})
