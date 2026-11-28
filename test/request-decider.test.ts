import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionComment } from '../src/agency-runtime/decide.ts'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import { storedRequestOf } from '../src/agency-runtime/requests.ts'
import { requestCommand } from '../src/requests/command.ts'
import { answer, answerOf, authorOf, deciderOf, isOwnerDecision, isSameAnswer, parseNewRequest } from '../src/requests/model.ts'
import { lintRequests } from '../src/requests/rules.ts'
import { readRequest, writeRequest } from '../src/requests/store.ts'
import type { OwnerRequest, RequestMessage } from '../src/requests/types.ts'
import { ownerWaits } from '../src/requests/waits.ts'
import { paths, type Paths } from '../src/store.ts'
import { config as runtimeConfig } from './agency-runtime-board.ts'
import { fakePorts } from './fake-ports.ts'
import { config, NOW } from './helpers.ts'

/**
 * Who decided is the participant the node names in the decision (`byParticipant`), and nothing else. The member id in `by` says whose device signed, and an
 * account can be called `owner`: a member with that id must not be shown, quoted, or acted on as the owner.
 */
const ID = 'r-20261008-060000-abcd'

function filed(to?: string): OwnerRequest {
  const result = parseNewRequest({ title: 'Deploy tonight?', options: [{ key: 'a', text: 'Tonight' }, { key: 'b', text: 'Tomorrow' }], ...(to === undefined ? {} : { to }) }, 'TechLead', NOW, ID)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

/** A decision the node relays: signed by the device of the member `by`, made by the participant `byParticipant`. */
const decidedBy = (request: OwnerRequest, by: string, participant: string): OwnerRequest => answer(request, { text: 'Go ahead.', choice: 'a' }, NOW, by, participant)

describe('a decision whose member id is `owner` but whose participant is not the owner', () => {
  // the request is addressed to `reviewer`, who decides on the device of a member whose account id is `owner`
  const request = decidedBy(filed('reviewer'), 'owner', 'reviewer')
  const message = request.messages[0] as RequestMessage

  it('is recorded as the participant\'s, with the member id kept apart', () => {
    assert.deepEqual([message.from, message.by, message.byParticipant], ['reviewer', 'owner', 'reviewer'])
    assert.deepEqual(deciderOf(request, message), { participant: 'reviewer', by: 'owner' })
    assert.equal(isOwnerDecision(request, message), false)
  })

  it('is shown in the team view\'s thread as that participant', () => {
    assert.equal(storedRequestOf(request).thread?.[0]?.from, 'reviewer')
    assert.equal(authorOf(request, message), 'reviewer')
  })

  it('reaches the lead as the participant\'s answer (R-ANSWERED), not the owner\'s, with their words quoted', () => {
    const [finding] = lintRequests([request], config)
    assert.match(finding?.message ?? '', /^reviewer \(member owner\) answered the request/)
    assert.doesNotMatch(finding?.message ?? '', new RegExp(`^${config.ownerLabel}`))
    assert.match(finding?.message ?? '', /chose "a: Tonight"/)
  })

  it('is listed by `scrum request show` as that participant, and says the member only signed', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-decider-')))
    writeRequest(p, request)
    const text = requestCommand(p, ['show', ID], {}, '', NOW)
    assert.match(text, /\] reviewer \(signed by the device of member owner\)/)
    assert.doesNotMatch(text, /\] owner /)
  })

  it('does not count as the owner\'s answer when the owner\'s wait is timed', () => {
    const unanswered = { ...filed(), messages: [message], waiting: 'owner' as const }
    // addressed to nobody, with a message from `reviewer` signed by the member `owner`: the owner has not answered
    assert.deepEqual(ownerWaits([unanswered], new Date(NOW.getTime() + 3_600_000)), [{ name: 'TechLead', from: NOW.getTime(), to: NOW.getTime() + 3_600_000 }])
  })

  it('is not the same answer as the owner\'s with the same member id, text, and choice', () => {
    const owners = decidedBy(filed(), 'owner', 'owner')
    assert.equal(isSameAnswer(owners, { text: 'Go ahead.', choice: 'a' }, 'owner', 'owner'), true)
    assert.equal(isSameAnswer(owners, { text: 'Go ahead.', choice: 'a' }, 'owner', 'reviewer'), false)
    assert.equal(isSameAnswer(request, { text: 'Go ahead.', choice: 'a' }, 'owner', 'owner'), false)
  })

  it('is quoted in the comment on the issue as the participant, with the member id as the device\'s', () => {
    const comment = decisionComment({ kind: 'judge', target: 'app#14', by: 'owner', byParticipant: 'reviewer', payload: { text: 'Go ahead.' } })
    assert.equal(comment.split('\n')[0], '<!-- agency-runtime:decision by=owner participant=reviewer -->')
    assert.match(comment, /\nDecision by the participant reviewer, signed by the device of member owner, relayed/)
    assert.doesNotMatch(comment, /Decision by the owner/)
  })
})

describe('a decision of the owner', () => {
  it('is the owner\'s when the participant is `owner`, whatever the member id is called', () => {
    for (const by of ['alice', 'owner', 'board']) {
      const request = decidedBy(filed(), by, 'owner')
      assert.equal(isOwnerDecision(request, request.messages[0] as RequestMessage), true, by)
      assert.equal(storedRequestOf(request).thread?.[0]?.from, 'owner', by)
      assert.match(lintRequests([request], config)[0]?.message ?? '', new RegExp(`^${config.ownerLabel} \\(member ${by}\\) answered`), by)
    }
  })

  it('is the answer a time of the owner\'s wait ends at', () => {
    const answeredAt = new Date(NOW.getTime() + 1_800_000)
    const answered = answer(filed(), { text: 'Go ahead.', choice: 'a' }, answeredAt, 'alice', 'owner')
    assert.equal(ownerWaits([answered], new Date(NOW.getTime() + 3_600_000))[0]?.to, answeredAt.getTime())
  })

  it('has its words and choice found by answerOf, for a participant\'s decision too', () => {
    assert.deepEqual(answerOf(decidedBy(filed(), 'owner', 'owner')), { chosen: 'chose "a: Tonight"', text: 'Go ahead.' })
    assert.deepEqual(answerOf(decidedBy(filed('reviewer'), 'owner', 'reviewer')), { chosen: 'chose "a: Tonight"', text: 'Go ahead.' })
  })
})

describe('a stored message that does not record the participant', () => {
  const stored = (extra: object): RequestMessage => ({ from: 'owner', text: 'Go.', at: NOW.toISOString(), ...extra })

  it('is the owner\'s only when it comes from a decision (it has a member id) and the request was addressed to nobody else, as one written earlier is', () => {
    assert.equal(deciderOf(filed(), stored({ by: 'alice' }))?.participant, 'owner')
    assert.equal(deciderOf(filed('reviewer'), stored({ by: 'alice' })), null)
    assert.equal(authorOf(filed('reviewer'), stored({ by: 'alice' })), 'unverified')
  })

  it('is unverified without a member id, or when it says one participant and records another', () => {
    assert.equal(authorOf(filed(), stored({})), 'unverified')
    assert.equal(authorOf(filed(), stored({ by: 'alice', byParticipant: 'reviewer' })), 'unverified')
    assert.equal(authorOf(filed(), { ...stored({ by: 'alice', byParticipant: 'owner' }), from: 'reviewer' }), 'reviewer')
    assert.equal(deciderOf(filed(), { ...stored({ by: 'alice', byParticipant: 'owner' }), from: 'reviewer' }), null)
  })

  it('is not taken for the owner\'s because the member id is called `owner`', () => {
    assert.equal(isOwnerDecision(filed('reviewer'), stored({ by: 'owner' })), false)
    assert.equal(isOwnerDecision(filed(), stored({ by: 'owner', byParticipant: 'reviewer', from: 'reviewer' })), false)
  })
})

describe('the runtime\'s decision', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-decider-run-')))
  })
  const deps = (): RuntimeDeps => ({ p, config: runtimeConfig, now: NOW, ports: fakePorts(), spawnRefresh: () => undefined, spawnUsageIndex: () => undefined })
  const decide = (by: string, byParticipant: string) =>
    runRuntime(JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'decide', decision: { kind: 'answer', target: ID, by, byParticipant, payload: { text: 'ok', choice: 'a' } } }), deps())

  it('records the participant that the node names, and the member id apart from it', () => {
    writeRequest(p, filed('reviewer'))
    assert.equal(decide('owner', 'reviewer').exitCode, 0)
    const message = readRequest(p, ID)?.messages[0]
    assert.deepEqual([message?.from, message?.by, message?.byParticipant], ['reviewer', 'owner', 'reviewer'])
  })

  it('does not take a member called `owner` for the owner: a participant who is not the addressee is refused, whatever the member id', () => {
    writeRequest(p, filed('reviewer'))
    assert.equal(decide('owner', 'auditor').exitCode, 1)
    assert.deepEqual(readRequest(p, ID)?.messages, [])
  })

  it('records the owner\'s decision as the owner\'s only for the participant `owner`', () => {
    writeRequest(p, filed())
    assert.equal(decide('alice', 'owner').exitCode, 0)
    const stored = readRequest(p, ID) as OwnerRequest
    assert.equal(isOwnerDecision(stored, stored.messages[0] as RequestMessage), true)
  })
})
