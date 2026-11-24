import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchMessage } from '../src/dispatch/message.ts'
import { config, issue } from './helpers.ts'

const withDispatch = {
  ...config,
  dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: ['note A', 'note B'] },
}

describe('dispatchMessage', () => {
  it('issue の番号と題、Status と担当、ブランチの土台、PR の宛先、マージする人、その日の決まりを入れる', () => {
    const text = dispatchMessage(issue(42, { title: 'Next job' }), 'SWE1', withDispatch)
    const lines = text.split('\n')
    assert.equal(lines[0], 'scrum-harness: handed the next work to SWE1.')
    assert.equal(lines[1], 'app#42 Next job')
    assert.match(text, /Set the board Status to In Progress and the assignee to SWE1/)
    assert.match(text, /Branch from origin\/develop\. The PR targets develop\. TechLead merges/)
    assert.match(text, /- note A\n- note B$/)
  })

  it('dispatch の設定が無くても、既定の土台で文面を作る', () => {
    assert.match(dispatchMessage(issue(1), 'SWE2', config), /Branch from origin\/main\. The PR targets main/)
  })

  it('同じ入力から同じ文面を作る (決まった文面)', () => {
    assert.equal(dispatchMessage(issue(5), 'SWE3', withDispatch), dispatchMessage(issue(5), 'SWE3', withDispatch))
    assert.doesNotMatch(dispatchMessage(issue(5), 'SWE3', withDispatch), /undefined|null/)
  })
})

describe('nudgeMessage', () => {
  it('自分の作業中の issue を進めるよう促し、待ちなら理由を付けて TechLead に伝えるよう書く。ボードは書き換えたと言わない', async () => {
    const { nudgeMessage } = await import('../src/dispatch/message.ts')
    const text = nudgeMessage(issue(240, { title: 'Ongoing job' }), 'SWE1', withDispatch)
    assert.equal(text.split('\n')[0], 'scrum-harness: SWE1 is idle. Continue app#240 Ongoing job, which is In Progress.')
    assert.match(text, /set the blocked reason on the board and then tell TechLead/)
    assert.doesNotMatch(text, /Set the board Status/)
  })
})
