import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { githubCodeHost } from '../src/adapters/github/code-host.ts'
import { LINK_GH_TIMEOUT_MS } from '../src/adapters/github/linked-branch.ts'
import type { GhRun } from '../src/adapters/github/gh.ts'
import { config, issue } from './helpers.ts'

/** A within that remembers the time limits it was called with and makes every gh fail. */
function recordingWithin(): { readonly within: (ms: number) => GhRun; readonly timeouts: number[] } {
  const timeouts: number[] = []
  const within = (ms: number): GhRun => {
    timeouts.push(ms)
    return () => {
      throw new Error('cannot call gh')
    }
  }
  return { within, timeouts }
}

const failingRun: GhRun = () => {
  throw new Error('gh without a time limit is not used')
}

describe('assembly of githubCodeHost', () => {
  it('the PR body read inside a hook uses a gh that cuts off at 15 seconds, and returns null when it cannot be read', () => {
    const { within, timeouts } = recordingWithin()
    const host = githubCodeHost(failingRun, config, within)
    assert.equal(host.referencedIssues('app#3', 'example-org/app'), null)
    assert.ok(timeouts.includes(15_000))
  })

  it('the branch prepared inside the hand-over lock uses a gh that cuts off at LINK_GH_TIMEOUT_MS', () => {
    const { within, timeouts } = recordingWithin()
    const withPrefix = { ...config, dispatch: { enabled: true, baseBranch: 'main', skipLabels: [], utcOffset: '+09:00', notes: [], linkedBranchPrefix: 'feat' } }
    const host = githubCodeHost(failingRun, withPrefix, within)
    assert.throws(() => host.prepareBranch(issue(5)), /cannot call gh/)
    assert.ok(timeouts.includes(LINK_GH_TIMEOUT_MS))
  })
})
