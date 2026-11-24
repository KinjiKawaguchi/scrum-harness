import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { teamViewProblem } from '../src/agency-runtime/validate.ts'
import { sample, SAMPLE_PATH } from './agency-runtime-fixture.ts'

const lock = readFileSync(new URL('../contract/agency.lock', import.meta.url), 'utf8')
const lockedValue = (key: string): string | undefined => new RegExp(`^${key}=(.+)$`, 'm').exec(lock)?.[1]

const clone = (): Record<string, any> => structuredClone(sample()) as Record<string, any>

describe("Agency's shared TeamView sample", () => {
  it('is the copy recorded in contract/agency.lock', () => {
    const hash = createHash('sha256').update(readFileSync(SAMPLE_PATH)).digest('hex')
    assert.equal(hash, lockedValue('fixture'))
  })

  it('passes the TeamView check', () => {
    assert.equal(teamViewProblem(sample()), null)
  })
})

describe('the TeamView check', () => {
  it('ignores keys it does not know, as the specification says', () => {
    const view = clone()
    view.people[0].futureField = 1
    view.futureSection = []
    assert.equal(teamViewProblem(view), null)
  })

  const broken: readonly (readonly [string, (view: Record<string, any>) => void, RegExp])[] = [
    ['a missing section', (view) => delete view.epics, /epics/],
    ['an optional key written as null', (view) => (view.people[1].since = null), /people\[1\]\.since/],
    ['a timestamp without Z', (view) => (view.generatedAt = '2026-11-24T12:00:00+09:00'), /generatedAt/],
    ['a date that is a timestamp', (view) => (view.work[1].blocked.since = '2026-11-23T00:00:00Z'), /blocked\.since/],
    ['a fractional number', (view) => (view.work[0].points = 2.5), /points/],
    ['a negative number', (view) => (view.epics[0].done = -1), /done/],
    ['an unknown person state', (view) => (view.people[0].state = 'busy'), /state/],
    ['an unknown work status', (view) => (view.work[0].status = 'doing'), /status/],
    ['an org that is not an id', (view) => (view.org = 'Acme Corp'), /org/],
    ['a waitingOn without a kind', (view) => (view.people[1].waitingOn = { person: 'owner' }), /waitingOn/],
  ]
  for (const [name, mutate, pattern] of broken) {
    it(`rejects ${name}`, () => {
      const view = clone()
      mutate(view)
      assert.match(teamViewProblem(view) ?? '', pattern)
    })
  }
})
