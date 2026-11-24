import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeOwner } from '../src/alerts/merge.ts'
import type { Notice } from '../src/alerts/types.ts'
import { enabled } from './alerts-fixtures.ts'

const notice = (key: string, line: string, waiting: readonly string[] = []): Notice => ({
  key,
  kind: 'owner',
  text: `- ${key}`,
  desktop: { title: 't', body: key },
  owner: { line, waiting },
})

describe('mergeOwner', () => {
  it('returns null when there are no notifications and returns a single one as is', () => {
    assert.equal(mergeOwner([], enabled), null)
    const one = notice('A', 'line a')
    assert.equal(mergeOwner([one], enabled), one)
  })

  it('merges 2 or more into one message, lists one line for each, and keeps all fingerprints of the merged items', () => {
    const merged = mergeOwner([notice('B', 'line b'), notice('A', 'line a')], enabled)
    assert.equal(merged?.kind, 'owner')
    assert.deepEqual(merged?.members, ['B', 'A'])
    assert.equal(merged?.key, 'batch:A+B')
    assert.equal(merged?.desktop?.body, 'There are 2 stalls.\n- line b\n- line a')
    assert.equal(
      merged?.text,
      ['- 2 stalls: send the owner one PushNotification (no sound; do not change the text)', '  There are 2 stalls.', '  - line b', '  - line a'].join('\n'),
    )
  })

  it('the target to which a question is attached is conveyed in one line for all that were merged', () => {
    const merged = mergeOwner([notice('A', 'a', ['app#1']), notice('B', 'b'), notice('C', 'c', ['app#2', 'app#3'])], enabled)
    assert.match(merged?.text ?? '', /\n  For the ones waiting for the owner's answer, add one line with the pending question \(subjects: app#1, app#2, app#3\)$/)
    assert.doesNotMatch(mergeOwner([notice('A', 'a'), notice('B', 'b')], enabled)?.text ?? '', /pending question/)
  })

  it('merging merged notifications again still keeps the original fingerprints', () => {
    const first = mergeOwner([notice('A', 'a'), notice('B', 'b')], enabled)
    const second = mergeOwner([first as Notice, notice('C', 'c')], enabled)
    assert.deepEqual(second?.members, ['A', 'B', 'C'])
  })

  it('the fingerprint does not depend on order', () => {
    assert.equal(mergeOwner([notice('A', 'a'), notice('B', 'b')], enabled)?.key, mergeOwner([notice('B', 'b'), notice('A', 'a')], enabled)?.key)
  })
})
