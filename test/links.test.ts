import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseConfig } from '../src/config.ts'
import type { GhRun } from '../src/adapters/github/gh.ts'
import { githubIssueThread } from '../src/adapters/github/issues.ts'
import { listOpenPrs } from '../src/adapters/github/pull-requests.ts'
import { DEFAULT_LINKS, parseLinks, type LinksConfig } from '../src/links/config.ts'
import { isSkipped, referencedNumbers, type OpenPr } from '../src/links/extract.ts'
import { isLinksDue, linkPullRequests as linkWithPorts, planLinks, runLinksIfDue as runWithPorts, type LinkPorts } from '../src/links/run.ts'
import { describe as describeTitle, entryLine, MARKER_END as END, MARKER_START as START, updateBody, type BodyUpdate } from '../src/links/section.ts'
import { paths, readJson, type Paths } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config, NOW } from './helpers.ts'

/** Uses a fake gh through the GitHub adapter (the shape of the gh calls that read and write PRs and issues is checked as well). */
const viaGh = (run: GhRun): LinkPorts => ({ code: { openPullRequests: (repo) => listOpenPrs(run, repo) }, issues: githubIssueThread(run) })
const linkPullRequests = (p: Paths, c: typeof config, now: Date, run: GhRun, options: { readonly dryRun: boolean }) => linkWithPorts(p, c, now, viaGh(run), options)
/** The ports used for one watch pass. Only PRs and issues are read through the fake gh; everything else stays inside the process. */
const watchPorts = (run: GhRun) => {
  const gh = viaGh(run)
  return fakePorts({ code: { ...fakePorts().code, ...gh.code }, issues: gh.issues })
}
const runLinksIfDue = (p: Paths, c: typeof config, now: Date, run: GhRun) => runWithPorts(p, c, now, viaGh(run))

const links: LinksConfig = { ...DEFAULT_LINKS, enabled: true }
const pr = (number: number, overrides: Partial<OpenPr> = {}): OpenPr => ({ number, title: `PR ${number}`, body: '', headRefName: `feat/x-${number}`, author: 'someone', ...overrides })

describe('referencedNumbers', () => {
  it('reads only the parentheses of the title, the number at the start of the branch name, and the Closes, Fixes, and Refs lines; returns them without duplicates, smallest first', () => {
    const target = pr(900, { title: 'feat: something (#30)', body: 'Closes #20\nRelated #10 and #30\nRefs #40\u3001#41', headRefName: 'feat/456-ci' })
    assert.deepEqual(referencedNumbers(target), [20, 30, 40, 41, 456])
  })

  it('returns the same number once even when the title, the body, and the branch name all point at it', () => {
    assert.deepEqual(referencedNumbers(pr(900, { title: 'x (#30)', body: 'Closes #30\nFixes #30', headRefName: 'feat/30-x' })), [30])
  })

  it("does not read a #N in the middle of the body or a #N outside the title's parentheses (numbers written for context, which would line a PR up under many issues)", () => {
    assert.deepEqual(referencedNumbers(pr(900, { title: 'Fix #5', body: 'Background: #10 and #11.\n- Related: #12', headRefName: 'topic' })), [])
  })

  it('Closes, Fixes, Resolves, and Refs are also read at the start of a bullet, in inflected forms (Closed, Fixed), and in any letter case', () => {
    const body = ['closes #1', '- Fixes #2', '* resolved #3', 'REFS: #4', '  Closed #5'].join('\n')
    assert.deepEqual(referencedNumbers(pr(900, { body, headRefName: 'topic' })), [1, 2, 3, 4, 5])
  })

  it('does not read a Closes line inside a code fence (```)', () => {
    const body = 'Closes #1\n```\nCloses #2\n```\nCloses #3'
    assert.deepEqual(referencedNumbers(pr(900, { body, headRefName: 'topic' })), [1, 3])
  })

  it("does not read the PR's own number", () => {
    assert.deepEqual(referencedNumbers(pr(5, { title: 'x (#5)', body: 'Closes #7' })), [7])
  })

  it('does not read repo#N, owner/repo#N, a character reference (&#123;), or a # in the middle of a word', () => {
    const body = 'Closes app#11 owner/app#12 &#123; abc#13 #14'
    assert.deepEqual(referencedNumbers(pr(900, { title: 'x (app#21)', body, headRefName: 'topic' })), [14])
  })

  it('reads a branch name only when a number follows a type prefix or sits at the start and is followed by a separator (- _ /) or the end', () => {
    const numbers = (name: string) => referencedNumbers(pr(900, { headRefName: name }))
    assert.deepEqual(numbers('docs/123-some-topic'), [123])
    assert.deepEqual(numbers('123-foo'), [123])
    assert.deepEqual(numbers('fix/123'), [123])
    assert.deepEqual(numbers('fix/123_x'), [123])
    assert.deepEqual(numbers('fix/123/sub'), [123])
    assert.deepEqual(numbers('fix/456abc'), [])
    assert.deepEqual(numbers('fix/456.5'), [])
    assert.deepEqual(numbers('feat/v2-thing'), [])
    assert.deepEqual(numbers('feat/guard-123'), [])
  })
})

describe('isSkipped', () => {
  it('does not count the Dependabot author or release/ and sync/ branches', () => {
    assert.equal(isSkipped(pr(1, { author: 'app/dependabot' }), links), true)
    assert.equal(isSkipped(pr(1, { author: 'dependabot[bot]' }), links), true)
    assert.equal(isSkipped(pr(1, { headRefName: 'release/1' }), links), true)
    assert.equal(isSkipped(pr(1, { headRefName: 'sync/main-to-develop' }), links), true)
    assert.equal(isSkipped(pr(1), links), false)
  })

  it('follows skipAuthors and skipBranchPrefixes of the config', () => {
    const custom = { ...links, skipAuthors: ['bot-x'], skipBranchPrefixes: ['tmp/'] }
    assert.equal(isSkipped(pr(1, { author: 'bot-x' }), custom), true)
    assert.equal(isSkipped(pr(1, { headRefName: 'tmp/a' }), custom), true)
    assert.equal(isSkipped(pr(1, { headRefName: 'release/1', author: 'app/dependabot' }), custom), false)
  })
})

describe('entryLine', () => {
  it('joins #<number> (description) entries with /', () => {
    assert.equal(entryLine([{ number: 12, title: 'feat: item 12' }, { number: 30, title: 'docs: item 30' }]), '#12 (feat: item 12) / #30 (docs: item 30)')
  })

  it('removes a trailing (#N) of the title together with its parentheses, and reduces any remaining #N to the bare number, so no mention of another issue is added', () => {
    assert.equal(describeTitle('feat: fix the settings (#789)'), 'feat: fix the settings')
    assert.equal(describeTitle('fix: x (#1\u3001#2)'), 'fix: x')
    assert.equal(describeTitle('fix: x ( #1, #2 )'), 'fix: x')
    assert.equal(describeTitle('Fix #7'), 'Fix 7')
    assert.equal(describeTitle('a (b) c'), 'a (b) c')
  })

  it('removes @ from the title so it does not trigger a mention notification; turns newlines into spaces', () => {
    assert.equal(describeTitle('Ask @someone'), 'Ask someone')
    assert.equal(describeTitle('a\nb\r\n  c'), 'a b c')
  })

  it('cuts at 60 characters and closes any parenthesis left open at the cut', () => {
    assert.equal(describeTitle('x'.repeat(70)), `${'x'.repeat(60)}…`)
    assert.equal(describeTitle(`(${'x'.repeat(70)})`), `(${'x'.repeat(59)}…)`)
    assert.equal(describeTitle('x'.repeat(60)), 'x'.repeat(60))
  })
})

describe('updateBody', () => {
  const entries = [{ number: 12, title: 'feat: item 12' }, { number: 30, title: 'docs: item 30' }]
  const block = (line: string, eol = '\n') => [START, `PRs in progress (automatic): ${line}`, END].join(eol)
  const LINE = '#12 (feat: item 12) / #30 (docs: item 30)'
  const updated = (result: BodyUpdate): string => {
    assert.equal(result.kind, 'updated')
    return result.kind === 'updated' ? result.body : ''
  }

  it('when there is no marker, appends a marker pair at the end of the body; does not change the original body by a single character (including a leading blank line and a trailing newline)', () => {
    const body = '\n\n## Goal\n\nBody text\n'
    assert.equal(updated(updateBody(body, entries)), `${body}\n${block(LINE)}\n`)
    assert.equal(updated(updateBody('', entries)), `${block(LINE)}\n`)
    assert.equal(updated(updateBody('No trailing newline', entries)), `No trailing newline\n\n${block(LINE)}\n`)
  })

  it('when markers exist, rewrites only between them and does not change the text before and after by a single character (including a later heading, subheading, # line, and signature line)', () => {
    const tail = '\n\n## Later heading\n### Subheading\nNote\n# Level 1\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
    const body = `Earlier text\n\n${block('#1 (old)')}${tail}`
    assert.equal(updated(updateBody(body, entries)), `Earlier text\n\n${block(LINE)}${tail}`)
  })

  it('does not touch a human-written "## PRs in progress" section; the marker pair is appended after it', () => {
    const body = '## PRs in progress\n\n#1 (Draft, waiting for review)\n\n## Next\n\nText\n'
    const result = updated(updateBody(body, entries))
    assert.ok(result.startsWith(body))
    assert.equal(result, `${body}\n${block(LINE)}\n`)
  })

  it('does not count markers inside a code fence (```); does not break the fence', () => {
    const body = `How to write the markers:\n\`\`\`\n${START}\n${END}\n\`\`\`\n`
    assert.equal(updated(updateBody(body, entries)), `${body}\n${block(LINE)}\n`)
  })

  it('does not treat marker characters in the middle of a line as a marker', () => {
    const body = `text ${START} text\n`
    assert.equal(updated(updateBody(body, entries)), `${body}\n${block(LINE)}\n`)
  })

  it('does not rewrite a body whose markers are broken (only one of them, 2 or more pairs, reversed order)', () => {
    assert.deepEqual(updateBody(`Before\n${START}\nAfter\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`Before\n${END}\nAfter\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`${block('a')}\n${block('b')}\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`${END}\n${START}\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`${START}\n`, []), { kind: 'broken' })
    assert.deepEqual(updateBody(`${START}\n${START}\n${END}\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`${START}\n${END}\n${END}\n`, entries), { kind: 'broken' })
  })

  it('does not change when the content is the same (does not rewrite on a second run)', () => {
    const once = updated(updateBody('Body text\n', entries))
    assert.deepEqual(updateBody(once, entries), { kind: 'unchanged' })
    const middle = updated(updateBody('Body text\n\n## Next\n\nText\n', entries))
    assert.deepEqual(updateBody(middle, entries), { kind: 'unchanged' })
  })

  it('when entries is empty, removes the marker pair; leaves the text around it alone; does nothing when there is no marker', () => {
    assert.equal(updated(updateBody(`Before\n\n${block('#1 (old)')}\n\nAfter\n`, [])), 'Before\n\nAfter\n')
    assert.equal(updated(updateBody(`Before\n\n${block('#1 (old)')}\n`, [])), 'Before\n')
    assert.equal(updated(updateBody(`${block('#1 (old)')}\n`, [])), '')
    assert.equal(updated(updateBody(`${block('#1 (old)')}\n\nAfter\n`, [])), 'After\n')
    assert.deepEqual(updateBody('Before\n', []), { kind: 'unchanged' })
  })

  it('adding and then removing returns the original body', () => {
    const body = 'Body text\n\n## Next\n\nText\n'
    assert.equal(updated(updateBody(updated(updateBody(body, entries)), [])), body)
  })

  it('writes a body with CRLF newlines using CRLF', () => {
    const body = 'Before\r\n\r\nText\r\n'
    assert.equal(updated(updateBody(body, entries)), `${body}\r\n${block(LINE, '\r\n')}\r\n`)
    const withBlock = `Before\r\n\r\n${block('#1 (old)', '\r\n')}\r\n\r\nAfter\r\n`
    assert.equal(updated(updateBody(withBlock, entries)), `Before\r\n\r\n${block(LINE, '\r\n')}\r\n\r\nAfter\r\n`)
  })
})

describe('planLinks', () => {
  const plain = (number: number, body = 'Goal\n') => ({ number, body })
  const withBlock = (number: number, line: string) => ({ number, body: `Goal\n\n${START}\nPRs in progress (automatic): ${line}\n${END}\n` })

  it('for each open issue, lists the PRs that point at it; a PR number or an issue that is not open has nowhere to add to', () => {
    const prs = [pr(50, { title: 'feat: a (#10)' }), pr(40, { body: 'Closes #10 and #11', headRefName: 'topic' }), pr(60, { body: 'Refs #999\nCloses #50', headRefName: 'topic' })]
    const { plans } = planLinks('example-org/app', prs, [plain(10), plain(11), withBlock(12, '#99 (closed PR)')], links)
    assert.deepEqual(plans.map((plan) => [plan.issue, plan.entries.map((entry) => entry.number)]), [[10, [40, 50]], [11, [40]], [12, []]])
  })

  it('a plan holds the original body (before) and the new body (after)', () => {
    const { plans } = planLinks('r/x', [pr(50, { title: 'docs: a (#10)', headRefName: 'topic' })], [plain(10)], links)
    assert.equal(plans[0]?.before, 'Goal\n')
    assert.equal(plans[0]?.after, `Goal\n\n${START}\nPRs in progress (automatic): #50 (docs: a)\n${END}\n`)
  })

  it('an issue that does not change is left out of the plan; an issue whose PRs are gone gets a plan that removes the marker pair', () => {
    const prs = [pr(50, { title: 'docs: a (#10)', headRefName: 'topic' })]
    const first = planLinks('r/x', prs, [plain(10)], links).plans[0]
    assert.deepEqual(planLinks('r/x', prs, [{ number: 10, body: first?.after ?? '' }], links), { plans: [], broken: [] })
    const removed = planLinks('r/x', [], [withBlock(12, '#99 (closed PR)')], links).plans
    assert.equal(removed[0]?.after, 'Goal\n')
  })

  it('even when the issue list is newest first (as gh actually returns it), the plan is in ascending number order', () => {
    const prs = [pr(50, { body: 'Closes #10\nCloses #11\nCloses #12', headRefName: 'topic' })]
    const { plans } = planLinks('r/x', prs, [plain(12), plain(10), plain(11)], links)
    assert.deepEqual(plans.map((plan) => plan.issue), [10, 11, 12])
  })

  it('an issue with a broken marker is left out of the plan and its number is returned in broken', () => {
    const prs = [pr(50, { body: 'Closes #10\nCloses #11', headRefName: 'topic' })]
    const planning = planLinks('r/x', prs, [plain(11), { number: 10, body: `${START}\nText\n` }], links)
    assert.deepEqual(planning.plans.map((plan) => plan.issue), [11])
    assert.deepEqual(planning.broken, [10])
  })

  it('does not count Dependabot and release/ PRs', () => {
    const prs = [pr(50, { body: 'Closes #10', author: 'app/dependabot' }), pr(51, { body: 'Closes #10', headRefName: 'release/1' })]
    assert.deepEqual(planLinks('r/x', prs, [plain(10)], links).plans, [])
  })

  it('a body with an unclosed code fence would swallow the added marker and make it unreadable, so it is left out of the plan and reported in broken (preventing a marker pair from being added on every run)', () => {
    const prs = [pr(50, { body: 'Closes #10\nCloses #11', headRefName: 'topic' })]
    const open = { number: 10, body: 'Steps:\n```sh\nscrum link-prs\n' }
    const planning = planLinks('r/x', prs, [open, plain(11)], links)
    assert.deepEqual(planning.plans.map((plan) => plan.issue), [11])
    assert.deepEqual(planning.broken, [10])
  })

  it('does not line up a PR under a #N in the middle of its body (a number written for context)', () => {
    const prs = [pr(50, { body: 'Background: continues #10.\nCloses #11', headRefName: 'topic' })]
    assert.deepEqual(planLinks('r/x', prs, [plain(10), plain(11)], links).plans.map((plan) => plan.issue), [11])
  })
})

describe('linkPullRequests', () => {
  let p: Paths
  let calls: (readonly string[])[]
  const prList = JSON.stringify([
    { number: 50, title: 'docs: a', body: 'Closes #10', headRefName: 'topic', author: { login: 'someone' } },
    { number: 51, title: 'chore: dep', body: 'Closes #10', headRefName: 'dependabot/x', author: { login: 'app/dependabot' } },
    { number: 'x', title: 'bad' },
  ])
  const AFTER_10 = `Goal\n\n${START}\nPRs in progress (automatic): #50 (docs: a)\n${END}\n`

  /** A fake gh. issues is the body the list returns, current is the body returned by the re-read just before writing (the same as the list if absent). PATCH calls are recorded. */
  function fake(issues: readonly { number: number; body: string }[], current: Record<number, { state: string; body: string } | 'FAIL'> = {}, onPatch?: (args: readonly string[]) => void): GhRun {
    return (args) => {
      calls.push(args)
      if (args[0] === 'pr') return prList
      if (args[0] === 'issue') return JSON.stringify(issues)
      if (args[0] !== 'api') throw new Error('unexpected call')
      if (args[1] === '-X') {
        onPatch?.(args)
        return '{}'
      }
      const number = Number(args[1]?.split('/').pop())
      const now = current[number] ?? { state: 'open', body: issues.find((one) => one.number === number)?.body ?? '' }
      if (now === 'FAIL') throw new Error('gh failed')
      return JSON.stringify(now)
    }
  }
  const patches = () => calls.filter((args) => args[1] === '-X')

  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-links-')))
    calls = []
  })

  const withRepos = (repos: readonly string[], overrides: Partial<LinksConfig> = {}) => ({ ...config, repos, links: { ...links, ...overrides } })

  it('reads PRs and issues, re-reads each issue whose body changes just before writing, and rewrites it with PATCH; the body is passed with -f', () => {
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, fake([{ number: 10, body: 'Goal\n' }]), { dryRun: false })
    assert.equal(result.applied.length, 1)
    assert.deepEqual(patches(), [['api', '-X', 'PATCH', 'repos/example-org/app/issues/10', '-f', `body=${AFTER_10}`]])
    const indexOf = (predicate: (args: readonly string[]) => boolean) => calls.findIndex(predicate)
    assert.ok(indexOf((args) => args[0] === 'api' && args[1] === 'repos/example-org/app/issues/10') < indexOf((args) => args[1] === '-X'))
    assert.match(readFileSync(p.events, 'utf8'), /"type":"link-prs","repo":"example-org\/app","issue":10,"prs":\[50\]/)
  })

  it('even for an issue whose body starts with @, passes the body in the form (-f) that is not read as a file', () => {
    linkPullRequests(p, withRepos(['r/x']), NOW, fake([{ number: 10, body: '@someone\n' }]), { dryRun: false })
    assert.equal(patches()[0]?.[4], '-f')
    assert.ok(patches()[0]?.[5]?.startsWith('body=@someone\n'))
  })

  it('leaves the body from before the write in log/links-before.jsonl before writing', () => {
    let beforeLog = ''
    linkPullRequests(p, withRepos(['example-org/app']), NOW, fake([{ number: 10, body: 'Goal\n' }], {}, () => { beforeLog = readFileSync(p.linksBefore, 'utf8') }), { dryRun: false })
    assert.deepEqual(JSON.parse(beforeLog.trim()), { at: NOW.toISOString(), repo: 'example-org/app', issue: 10, body: 'Goal\n' })
  })

  it('when the re-read body differs from the one the plan was built from (a person edited it), does not write; records the reason and does not keep the original body', () => {
    const run = fake([{ number: 10, body: 'Goal\n' }], { 10: { state: 'open', body: 'Goal\nA sentence added by a person\n' } })
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, run, { dryRun: false })
    assert.deepEqual([result.applied.length, result.skipped.map((one) => one.reason)], [0, ['changed']])
    assert.equal(patches().length, 0)
    assert.match(readFileSync(p.events, 'utf8'), /"type":"link-skipped","repo":"example-org\/app","issue":10,"reason":"changed"/)
    assert.throws(() => readFileSync(p.linksBefore, 'utf8'), /ENOENT/)
  })

  it('when the issue is closed at re-read time, does not write', () => {
    const run = fake([{ number: 10, body: 'Goal\n' }], { 10: { state: 'closed', body: 'Goal\n' } })
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, run, { dryRun: false })
    assert.deepEqual(result.skipped.map((one) => one.reason), ['closed'])
    assert.equal(patches().length, 0)
  })

  it('even if the re-read of one issue fails, records it and moves on to the next issue', () => {
    const issues = [{ number: 10, body: 'Goal\n' }, { number: 11, body: 'Goal\n' }]
    const prs = JSON.stringify([{ number: 50, title: 'docs: a', body: 'Closes #10\nCloses #11', headRefName: 'topic', author: { login: 'a' } }])
    const base = fake(issues, { 10: 'FAIL' })
    const run: GhRun = (args) => (args[0] === 'pr' ? prs : base(args))
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, run, { dryRun: false })
    assert.deepEqual([result.applied.map((plan) => plan.issue), result.skipped.map((one) => one.reason)], [[11], ['failed']])
    assert.match(readFileSync(p.errors, 'utf8'), /link-prs example-org\/app#10: gh failed/)
  })

  it('dryRun returns only the plan and neither re-reads nor rewrites', () => {
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, fake([{ number: 10, body: 'Goal\n' }]), { dryRun: true })
    assert.deepEqual([result.planned.length, result.applied.length], [1, 0])
    assert.equal(calls.some((args) => args[0] === 'api'), false)
  })

  it('rewrites at most maxEditsPerRun issues per run; applies them in ascending number order even when gh returns newest first', () => {
    const newestFirst = [14, 13, 12, 11, 10].map((number) => ({ number, body: 'Goal\n' }))
    const prs = JSON.stringify([{ number: 50, title: 't', body: 'Closes #10 #11 #12 #13 #14', headRefName: 'topic', author: { login: 'a' } }])
    const base = fake(newestFirst)
    const run: GhRun = (args) => (args[0] === 'pr' ? prs : base(args))
    const result = linkPullRequests(p, withRepos(['r/x'], { maxEditsPerRun: 2 }), NOW, run, { dryRun: false })
    assert.deepEqual(result.applied.map((plan) => plan.issue), [10, 11])
    assert.deepEqual(result.planned.map((plan) => plan.issue), [10, 11, 12, 13, 14])
  })

  it('the per-run limit maxEditsPerRun counts across the whole repository set (not per repository)', () => {
    const issues = [10, 11, 12].map((number) => ({ number, body: 'Goal\n' }))
    const prs = JSON.stringify([{ number: 50, title: 't', body: 'Closes #10 #11 #12', headRefName: 'topic', author: { login: 'a' } }])
    const base = fake(issues)
    const run: GhRun = (args) => (args[0] === 'pr' ? prs : base(args))
    const result = linkPullRequests(p, withRepos(['r/a', 'r/b'], { maxEditsPerRun: 4 }), NOW, run, { dryRun: false })
    assert.deepEqual(result.applied.map((plan) => `${plan.repo}#${plan.issue}`), ['r/a#10', 'r/a#11', 'r/a#12', 'r/b#10'])
    assert.equal(result.planned.length, 6)
  })

  it("the limit also counts the skipped ones (edited by a person); each skipped one reduces the next repository's quota", () => {
    const issues = [10, 11].map((number) => ({ number, body: 'Goal\n' }))
    const prs = JSON.stringify([{ number: 50, title: 't', body: 'Closes #10 #11', headRefName: 'topic', author: { login: 'a' } }])
    const base = fake(issues, { 10: { state: 'open', body: 'Fixed by a person\n' } })
    const run: GhRun = (args) => (args[0] === 'pr' ? prs : base(args))
    const result = linkPullRequests(p, withRepos(['r/a', 'r/b'], { maxEditsPerRun: 2 }), NOW, run, { dryRun: false })
    assert.deepEqual(result.applied.map((plan) => `${plan.repo}#${plan.issue}`), ['r/a#11'])
    assert.deepEqual(result.skipped.map((one) => `${one.plan.repo}#${one.plan.issue}`), ['r/a#10'])
  })

  it('an issue with a broken marker is not rewritten and appears in the result and the record', () => {
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, fake([{ number: 10, body: `${START}\nText\n` }]), { dryRun: false })
    assert.deepEqual(result.broken, [{ repo: 'example-org/app', issue: 10 }])
    assert.equal(patches().length, 0)
    assert.match(readFileSync(p.events, 'utf8'), /"type":"link-broken","repo":"example-org\/app","issue":10/)
  })

  it('a repository that fails to read is recorded and skipped, and the other repositories proceed', () => {
    const base = fake([{ number: 10, body: 'Goal\n' }])
    const run: GhRun = (args) => {
      if (args.includes('bad/repo')) throw new Error('gh failed')
      return base(args)
    }
    const result = linkPullRequests(p, withRepos(['bad/repo', 'example-org/app']), NOW, run, { dryRun: false })
    assert.equal(result.applied.length, 1)
    assert.match(readFileSync(p.errors, 'utf8'), /link-prs bad\/repo: gh failed/)
  })

  it('reading the PR list: drops an unreadable entry (a non-numeric number)', () => {
    assert.deepEqual(listOpenPrs(() => prList, 'r/x').map((one) => one.number), [50, 51])
  })
})

describe('isLinksDue and runLinksIfDue', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-links-due-')))
  })
  const enabled = { ...config, repos: ['example-org/app'], links }
  const quiet: GhRun = (args) => (args[0] === 'api' ? '{}' : '[]')

  it('does not run when links is absent or disabled; does not run a second time until the interval (default 30 minutes) has passed', () => {
    assert.equal(isLinksDue(p, config, NOW), false)
    assert.equal(isLinksDue(p, { ...config, links: { ...links, enabled: false } }, NOW), false)
    assert.equal(isLinksDue(p, enabled, NOW), true)
    assert.notEqual(runLinksIfDue(p, enabled, NOW, quiet), null)
    assert.equal(runLinksIfDue(p, enabled, new Date(NOW.getTime() + 29 * 60_000), quiet), null)
    assert.notEqual(runLinksIfDue(p, enabled, new Date(NOW.getTime() + 30 * 60_000), quiet), null)
  })

  it('when another live process holds the lock, does not run and does not write the time', () => {
    mkdirSync(dirname(p.linksLock), { recursive: true })
    writeFileSync(p.linksLock, String(process.ppid))
    assert.equal(runLinksIfDue(p, enabled, NOW, quiet), null)
    assert.equal(readJson(p.linksState, null), null)
  })

  it('after running, writes the time it ran (even on failure, does not try again within the interval)', () => {
    runLinksIfDue(p, enabled, NOW, () => {
      throw new Error('gh failed')
    })
    assert.equal(readJson(p.linksState, null), NOW.toISOString())
    assert.equal(isLinksDue(p, enabled, new Date(NOW.getTime() + 60_000)), false)
  })
})

describe('parseLinks', () => {
  it('with only enabled given, fills the rest with defaults', () => {
    assert.deepEqual(parseLinks({ enabled: true }), { ...DEFAULT_LINKS, enabled: true })
  })

  it('when the shape is wrong, stops only this feature', () => {
    const bad = [null, 'x', {}, { enabled: 1 }, { enabled: true, intervalMinutes: 0 }, { enabled: true, maxEditsPerRun: 1.5 }, { enabled: true, skipAuthors: 'a' }]
    bad.forEach((raw) => assert.equal(parseLinks(raw), undefined, JSON.stringify(raw)))
  })

  it('even if links in the config file is broken, the whole config can be read', () => {
    assert.equal(parseConfig({ ...config, links: { enabled: 'x' } })?.links, undefined)
    assert.equal(parseConfig({ ...config, links: { enabled: true } })?.links?.enabled, true)
  })
})

describe('TechLead watch', async () => {
  const { runWatch } = await import('../src/watch.ts')
  const { saveSnapshot } = await import('../src/board/snapshot.ts')
  const { snapshot } = await import('./helpers.ts')

  it('when links is enabled, reads the open PRs on one watch pass (does not read on the second pass within the interval)', async () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-links-watch-')))
    saveSnapshot(p, { ...snapshot([]), fetchedAt: new Date().toISOString() })
    const calls: (readonly string[])[] = []
    const run: GhRun = (args) => {
      calls.push(args)
      return args[0] === 'api' ? '{}' : '[]'
    }
    await runWatch(p, { ...config, repos: ['example-org/app'], links }, { maxMs: 200, intervalMs: 20 }, watchPorts(run))
    assert.equal(calls.filter((args) => args[0] === 'pr').length, 1)
    assert.equal(calls.filter((args) => args[0] === 'issue').length, 1)
  })

  it('does not call gh when links is absent', async () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-links-watch-')))
    saveSnapshot(p, { ...snapshot([]), fetchedAt: new Date().toISOString() })
    const calls: (readonly string[])[] = []
    const run: GhRun = (args) => {
      calls.push(args)
      return '[]'
    }
    await runWatch(p, { ...config, repos: ['example-org/app'] }, { maxMs: 100, intervalMs: 20 }, watchPorts(run))
    assert.equal(calls.length, 0)
  })
})
