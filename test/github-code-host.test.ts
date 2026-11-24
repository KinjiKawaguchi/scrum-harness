import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { githubCodeHost } from '../src/adapters/github/code-host.ts'
import { LINK_GH_TIMEOUT_MS } from '../src/adapters/github/linked-branch.ts'
import type { GhRun } from '../src/adapters/github/gh.ts'
import { config, issue } from './helpers.ts'

/** 呼ばれた打ち切りの時間を覚え、どの gh も失敗する within。 */
function recordingWithin(): { readonly within: (ms: number) => GhRun; readonly timeouts: number[] } {
  const timeouts: number[] = []
  const within = (ms: number): GhRun => {
    timeouts.push(ms)
    return () => {
      throw new Error('gh を呼べない')
    }
  }
  return { within, timeouts }
}

const failingRun: GhRun = () => {
  throw new Error('時間を絞らない gh は使わない')
}

describe('githubCodeHost の組み立て', () => {
  it('フックの中で読む PR の本文は、15 秒で打ち切る gh を使い、読めなければ null を返す', () => {
    const { within, timeouts } = recordingWithin()
    const host = githubCodeHost(failingRun, config, within)
    assert.equal(host.referencedIssues('app#3', 'example-org/app'), null)
    assert.ok(timeouts.includes(15_000))
  })

  it('渡しの錠の中で用意するブランチは、LINK_GH_TIMEOUT_MS で打ち切る gh を使う', () => {
    const { within, timeouts } = recordingWithin()
    const withPrefix = { ...config, dispatch: { enabled: true, baseBranch: 'main', skipLabels: [], utcOffset: '+09:00', notes: [], linkedBranchPrefix: 'feat' } }
    const host = githubCodeHost(failingRun, withPrefix, within)
    assert.throws(() => host.prepareBranch(issue(5)), /gh を呼べない/)
    assert.ok(timeouts.includes(LINK_GH_TIMEOUT_MS))
  })
})
