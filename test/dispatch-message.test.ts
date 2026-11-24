import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchMessage } from '../src/dispatch/message.ts'
import { config, issue } from './helpers.ts'

const withDispatch = {
  ...config,
  dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: ['note A', 'note B'] },
}

describe('dispatchMessage', () => {
  it('includes the issue number and title, Status and assignee, the branch base, the PR target, who merges, and the rules of the day', () => {
    const text = dispatchMessage(issue(42, { title: 'Next job' }), 'SWE1', withDispatch)
    const lines = text.split('\n')
    assert.equal(lines[0], 'scrum-harness: handed the next work to SWE1.')
    assert.equal(lines[1], 'app#42 Next job')
    assert.match(text, /Set the board Status to In Progress and the assignee to SWE1/)
    assert.match(text, /Branch from origin\/develop\. The PR targets develop\. TechLead merges/)
    assert.match(text, /- note A\n- note B$/)
  })

  it('builds the message with the default base even when there is no dispatch config', () => {
    assert.match(dispatchMessage(issue(1), 'SWE2', config), /Branch from origin\/main\. The PR targets main/)
  })

  it('builds the same message from the same input (a fixed text)', () => {
    assert.equal(dispatchMessage(issue(5), 'SWE3', withDispatch), dispatchMessage(issue(5), 'SWE3', withDispatch))
    assert.doesNotMatch(dispatchMessage(issue(5), 'SWE3', withDispatch), /undefined|null/)
  })
})

describe('nudgeMessage', () => {
  it('nudges the member to move forward their own In Progress issue, and tells them to report to the TechLead with a reason if waiting; does not claim the board was rewritten', async () => {
    const { nudgeMessage } = await import('../src/dispatch/message.ts')
    const text = nudgeMessage(issue(240, { title: 'Ongoing job' }), 'SWE1', withDispatch)
    assert.equal(text.split('\n')[0], 'scrum-harness: SWE1 is idle. Continue app#240 Ongoing job, which is In Progress.')
    assert.match(text, /set the blocked reason on the board and then tell TechLead/)
    assert.doesNotMatch(text, /Set the board Status/)
  })
})
