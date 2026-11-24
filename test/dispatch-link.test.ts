import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { parseConfig } from '../src/config.ts'
import { readDispatches } from '../src/dispatch/records.ts'
import { ghWithin, type GhRun } from '../src/adapters/github/gh.ts'
import { branchName, ensureLinkedBranch, LINK_GH_TIMEOUT_MS, linkBranchWith, parseLookup } from '../src/adapters/github/linked-branch.ts'
import { dispatchMessage } from '../src/dispatch/message.ts'
import { dispatchStep } from '../src/dispatch/run.ts'
import type { CodeHost } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import { fakePorts } from './fake-ports.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const withPrefix = { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: [], linkedBranchPrefix: 'feat' } }

const lookup = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: { repository: { id: 'R_1', issue: { id: 'I_1', linkedBranches: { nodes: [] } }, ref: { target: { oid: 'abc123' } }, ...overrides } },
  })

function fakeGh(responses: readonly string[]): { readonly run: GhRun; readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  return {
    calls,
    run: (args) => {
      calls.push(args)
      const next = responses[calls.length - 1]
      if (next === undefined) throw new Error('unexpected call')
      if (next === 'FAIL') throw new Error('gh failed')
      return next
    },
  }
}

describe('parseLookup', () => {
  it('reads the repository and issue ID, the linked branches, and the head of the base', () => {
    const linked = lookup({ issue: { id: 'I_9', linkedBranches: { nodes: [{ ref: { name: 'feat/9' } }, { ref: null }] } } })
    assert.deepEqual(parseLookup(linked), { repositoryId: 'R_1', issueId: 'I_9', linked: ['feat/9'], oid: 'abc123' })
  })

  it('throws with a reason for a shape it cannot read', () => {
    assert.throws(() => parseLookup(JSON.stringify({ data: { repository: null } })), /cannot read the repository/)
    assert.throws(() => parseLookup(lookup({ id: '' })), /repository ID/)
    assert.throws(() => parseLookup(lookup({ issue: null })), /the issue does not exist/)
    assert.throws(() => parseLookup(lookup({ ref: null })), /the base branch does not exist/)
    assert.throws(() => parseLookup('broken'))
  })
})

describe('ensureLinkedBranch', () => {
  const input = { repo: 'example-org/app', number: 123, baseBranch: 'develop', prefix: 'feat' }

  it('when no branch is linked, creates feat/<number> from the oid of the base head', () => {
    const { run, calls } = fakeGh([lookup(), '{}'])
    assert.deepEqual(ensureLinkedBranch(run, input), { name: 'feat/123', isNew: true })
    const query = calls[0] ?? []
    assert.ok(query.includes('owner=example-org') && query.includes('name=app') && query.includes('number=123') && query.includes('ref=refs/heads/develop'))
    // number is a GraphQL Int!, so it is passed with -F (which reads the type). With -f it becomes a string and the query fails every time
    assert.equal(query[query.indexOf('number=123') - 1], '-F')
    const stringArgs = ['owner=example-org', 'name=app', 'ref=refs/heads/develop']
    stringArgs.forEach((arg) => assert.equal(query[query.indexOf(arg) - 1], '-f', arg))
    const mutation = calls[1] ?? []
    assert.ok(['issue=I_1', 'oid=abc123', 'name=feat/123', 'repo=R_1'].every((arg) => mutation.includes(arg)))
    assert.ok(mutation.some((arg) => arg.startsWith('query=mutation') && arg.includes('createLinkedBranch')))
    ;['issue=I_1', 'oid=abc123', 'name=feat/123', 'repo=R_1'].forEach((arg) => assert.equal(mutation[mutation.indexOf(arg) - 1], '-f', arg))
  })

  it('when a linked branch already exists, returns it without creating one', () => {
    const { run, calls } = fakeGh([lookup({ issue: { id: 'I_1', linkedBranches: { nodes: [{ ref: { name: 'feat/old-name' } }] } } })])
    assert.deepEqual(ensureLinkedBranch(run, input), { name: 'feat/old-name', isNew: false })
    assert.equal(calls.length, 1)
  })

  it('when several branches are linked, returns the first one (creates none)', () => {
    const nodes = [{ ref: { name: 'feat/first' } }, { ref: { name: 'feat/second' } }]
    const { run, calls } = fakeGh([lookup({ issue: { id: 'I_1', linkedBranches: { nodes } } })])
    assert.deepEqual(ensureLinkedBranch(run, input), { name: 'feat/first', isNew: false })
    assert.equal(calls.length, 1)
  })

  it('throws when creation fails (for example when a branch of the same name already exists)', () => {
    const { run } = fakeGh([lookup(), 'FAIL'])
    assert.throws(() => ensureLinkedBranch(run, input), /gh failed/)
  })

  it('the branch name is <prefix>/<number>', () => {
    assert.equal(branchName('fix', 7), 'fix/7')
  })
})

describe('linkBranchWith', () => {
  it('returns null without calling gh when linkedBranchPrefix is absent', () => {
    const { run, calls } = fakeGh([])
    assert.equal(linkBranchWith(run, { ...config, dispatch: { ...withPrefix.dispatch, linkedBranchPrefix: undefined } })(issue(11)), null)
    assert.equal(calls.length, 0)
  })

  it('returns null for an item without a number (a draft)', () => {
    const { run, calls } = fakeGh([])
    assert.equal(linkBranchWith(run, withPrefix)(issue(11, { number: null })), null)
    assert.equal(calls.length, 0)
  })

  it("uses the item's repository and the config's baseBranch", () => {
    const { run, calls } = fakeGh([lookup(), '{}'])
    assert.deepEqual(linkBranchWith(run, withPrefix)(issue(11)), { name: 'feat/11', isNew: true })
    assert.ok((calls[0] ?? []).includes('owner=example-org') && (calls[0] ?? []).includes('ref=refs/heads/develop'))
  })
})

describe('branch line of dispatchMessage', () => {
  const item = issue(11, { title: 'Next job', repo: 'example-org/app' })

  it('for a created branch, tells the name, the base, and to write the number in the PR body', () => {
    const text = dispatchMessage(item, 'SWE1', withPrefix, { name: 'feat/11', isNew: true })
    assert.match(text, /- A branch feat\/11 linked to the issue was created from the tip of origin\/develop\. Run git fetch origin, work on this branch/)
    assert.match(text, /- Write #11 in the PR body \(so the PR links to the issue\)/)
  })

  it('for an already existing branch, says so, and since its base may be stale, has the member check whether it has fallen behind origin/develop before working', () => {
    const text = dispatchMessage(item, 'SWE1', withPrefix, { name: 'feat/old', isNew: false })
    assert.match(text, /The issue already had a linked branch, feat\/old\. Its base may be old, so after git fetch origin check with git log feat\/old\.\.origin\/develop that it is not behind origin\/develop, then work on this branch/)
    assert.doesNotMatch(dispatchMessage(item, 'SWE1', withPrefix, { name: 'feat/11', isNew: true }), /not behind|already had a linked branch/)
  })

  it('when it could not be prepared, tells the member to cut one and to write the number in the body', () => {
    assert.match(dispatchMessage(item, 'SWE1', withPrefix, 'failed'), /Could not prepare a branch linked to the issue \(see errors\.log\)\. Create a branch yourself, and write #11 in the PR body/)
  })

  it('with a setting that does not handle branches (null), the message text stays the same', () => {
    const text = dispatchMessage(item, 'SWE1', withPrefix, null)
    assert.doesNotMatch(text, /linked branch|in the PR body/)
    assert.equal(text, dispatchMessage(item, 'SWE1', withPrefix))
  })
})

describe('linkedBranchPrefix of parseConfig', () => {
  const parse = (prefix: unknown) => parseConfig({ ...config, dispatch: { enabled: true, linkedBranchPrefix: prefix } })?.dispatch

  it('accepts names made of letters, digits, dots, hyphens, underscores, and parts separated by /', () => {
    assert.equal(parse('feat')?.linkedBranchPrefix, 'feat')
    assert.equal(parse('feat/auto')?.linkedBranchPrefix, 'feat/auto')
  })

  it('does not use the whole dispatch config for an empty or blank value, a leading or trailing /, or a non-string value', () => {
    for (const bad of ['', 'a b', '/feat', 'feat/', 'feat//x', 3, '\u65e5\u672c\u8a9e']) assert.equal(parse(bad), undefined, String(bad))
  })

  it('when not written, stays absent', () => {
    assert.equal(parseConfig({ ...config, dispatch: { enabled: true } })?.dispatch?.linkedBranchPrefix, undefined)
  })
})

describe('branch handling of dispatchStep', () => {
  let p: Paths
  /** A port that stays inside the process, with only the branch preparation swapped out */
  const withLink = (prepareBranch: CodeHost['prepareBranch']) => fakePorts({ code: { ...fakePorts().code, prepareBranch } })
  const board = () => saveSnapshot(p, snapshot([issue(11, { status: 'Next', title: 'Next job' })]))

  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-link-')))
    writeHeartbeat(p, { sessionId: 'session-SWE1', name: 'SWE1', pid: null }, 'idle', new Date(NOW.getTime() - 20 * 60_000))
    board()
  })

  it('prepares a linked branch and keeps it in the record and the message', () => {
    const outcome = dispatchStep(p, withPrefix, 'SWE1', NOW, withLink(() => ({ name: 'feat/11', isNew: true })))
    assert.match(outcome?.message ?? '', /A branch feat\/11 linked to the issue was created from the tip of origin\/develop/)
    assert.equal(outcome?.record.branch, 'feat/11')
    assert.equal(readDispatches(p)[0]?.branch, 'feat/11')
    assert.match(readFileSync(p.events, 'utf8'), /"branch":"feat\/11"/)
  })

  it('a preparation failure does not stop the hand-over; the failure is recorded and written in the message', () => {
    const outcome = dispatchStep(
      p,
      withPrefix,
      'SWE1',
      NOW,
      withLink(() => {
        throw new Error('cannot create the branch')
      }),
    )
    assert.match(outcome?.message ?? '', /Could not prepare a branch linked to the issue/)
    assert.equal(outcome?.record.branch, undefined)
    assert.match(readFileSync(p.errors, 'utf8'), /dispatch-link: cannot create the branch/)
    assert.equal(readDispatches(p).length, 1)
  })

  it('with a setting that does not handle branches, the result of the preparation call (null) does not appear in the message', () => {
    const outcome = dispatchStep(p, withPrefix, 'SWE1', NOW, withLink(() => null))
    assert.doesNotMatch(outcome?.message ?? '', /A branch feat|Could not prepare/)
    assert.equal(outcome?.record.branch, undefined)
  })

  it('the GitHub preparation does not call gh when linkedBranchPrefix is absent', () => {
    const plain = { ...withPrefix, dispatch: { ...withPrefix.dispatch, linkedBranchPrefix: undefined } }
    const { run, calls } = fakeGh([])
    const outcome = dispatchStep(p, plain, 'SWE1', NOW, withLink(linkBranchWith(run, plain)))
    assert.equal(calls.length, 0)
    assert.match(outcome?.message ?? '', /^scrum-harness: handed the next work to SWE1/)
    assert.doesNotMatch(outcome?.message ?? '', /A branch feat/)
  })

  it('the nudge message does not prepare a branch', () => {
    saveSnapshot(p, snapshot([issue(12, { status: 'In Progress', assignee: 'SWE1', title: 'Ongoing' })]))
    let called = false
    const outcome = dispatchStep(
      p,
      withPrefix,
      'SWE1',
      NOW,
      withLink(() => {
        called = true
        return null
      }),
    )
    assert.match(outcome?.message ?? '', /Continue/)
    assert.equal(called, false)
  })
})

describe('gh timeout inside the hand-over lock', () => {
  it('one gh call is cut off at 15 seconds; with at most 2 calls, the lock is held for up to 30 seconds', () => {
    assert.equal(LINK_GH_TIMEOUT_MS, 15_000)
  })

  it('ghWithin cuts off and throws for a gh call that exceeds the given time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-fake-gh-'))
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nsleep 5\n')
    chmodSync(join(dir, 'gh'), 0o755)
    const saved = process.env.PATH
    process.env.PATH = `${dir}:${saved ?? ''}`
    try {
      const startedAt = Date.now()
      assert.throws(() => ghWithin(300)(['api', 'x']))
      assert.ok(Date.now() - startedAt < 3000)
    } finally {
      process.env.PATH = saved
    }
  })
})
