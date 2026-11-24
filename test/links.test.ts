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

/** gh の偽物を、GitHub のアダプタ越しに使う (PR と issue の読み書きの gh の形も、合わせて見る)。 */
const viaGh = (run: GhRun): LinkPorts => ({ code: { openPullRequests: (repo) => listOpenPrs(run, repo) }, issues: githubIssueThread(run) })
const linkPullRequests = (p: Paths, c: typeof config, now: Date, run: GhRun, options: { readonly dryRun: boolean }) => linkWithPorts(p, c, now, viaGh(run), options)
/** 待機の 1 周で使うポート。PR と issue だけを gh の偽物で読み、ほかは外に出ない。 */
const watchPorts = (run: GhRun) => {
  const gh = viaGh(run)
  return fakePorts({ code: { ...fakePorts().code, ...gh.code }, issues: gh.issues })
}
const runLinksIfDue = (p: Paths, c: typeof config, now: Date, run: GhRun) => runWithPorts(p, c, now, viaGh(run))

const links: LinksConfig = { ...DEFAULT_LINKS, enabled: true }
const pr = (number: number, overrides: Partial<OpenPr> = {}): OpenPr => ({ number, title: `PR ${number}`, body: '', headRefName: `feat/x-${number}`, author: 'someone', ...overrides })

describe('referencedNumbers', () => {
  it('題の括弧の中、ブランチ名の先頭の番号、Closes と Fixes と Refs の行だけを読み、重複なしで、小さい順に返す', () => {
    const target = pr(900, { title: 'feat: 何か (#30)', body: 'Closes #20\n関連 #10 と #30\nRefs #40、#41', headRefName: 'feat/456-ci' })
    assert.deepEqual(referencedNumbers(target), [20, 30, 40, 41, 456])
  })

  it('同じ番号を、題と本文とブランチ名で重ねて指しても、1 回だけ返す', () => {
    assert.deepEqual(referencedNumbers(pr(900, { title: 'x (#30)', body: 'Closes #30\nFixes #30', headRefName: 'feat/30-x' })), [30])
  })

  it('本文の途中の #N、題の括弧の外の #N は読まない (文脈のために書いた番号で、PR が何本もの issue に並ぶため)', () => {
    assert.deepEqual(referencedNumbers(pr(900, { title: '#5 を直す', body: '背景は #10 と #11。\n- 関連: #12', headRefName: 'topic' })), [])
  })

  it('Closes、Fixes、Resolves、Refs は、箇条書きの先頭や、活用 (Closed、Fixed) や、大文字小文字の違いも読む', () => {
    const body = ['closes #1', '- Fixes #2', '* resolved #3', 'REFS: #4', '  Closed #5'].join('\n')
    assert.deepEqual(referencedNumbers(pr(900, { body, headRefName: 'topic' })), [1, 2, 3, 4, 5])
  })

  it('コードの囲み (```) の中の Closes の行は読まない', () => {
    const body = 'Closes #1\n```\nCloses #2\n```\nCloses #3'
    assert.deepEqual(referencedNumbers(pr(900, { body, headRefName: 'topic' })), [1, 3])
  })

  it('自分の PR の番号は読まない', () => {
    assert.deepEqual(referencedNumbers(pr(5, { title: 'x (#5)', body: 'Closes #7' })), [7])
  })

  it('repo#N、owner/repo#N、文字参照 (&#123;)、単語の途中の # は読まない', () => {
    const body = 'Closes app#11 owner/app#12 &#123; abc#13 #14'
    assert.deepEqual(referencedNumbers(pr(900, { title: 'x (app#21)', body, headRefName: 'topic' })), [14])
  })

  it('ブランチ名は、種類の接頭辞の後か先頭の数字で、その後ろが区切り (- _ /) か終わりのときだけ読む', () => {
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
  it('Dependabot の作者と、release/ と sync/ のブランチは数えない', () => {
    assert.equal(isSkipped(pr(1, { author: 'app/dependabot' }), links), true)
    assert.equal(isSkipped(pr(1, { author: 'dependabot[bot]' }), links), true)
    assert.equal(isSkipped(pr(1, { headRefName: 'release/1' }), links), true)
    assert.equal(isSkipped(pr(1, { headRefName: 'sync/main-to-develop' }), links), true)
    assert.equal(isSkipped(pr(1), links), false)
  })

  it('設定の skipAuthors と skipBranchPrefixes に従う', () => {
    const custom = { ...links, skipAuthors: ['bot-x'], skipBranchPrefixes: ['tmp/'] }
    assert.equal(isSkipped(pr(1, { author: 'bot-x' }), custom), true)
    assert.equal(isSkipped(pr(1, { headRefName: 'tmp/a' }), custom), true)
    assert.equal(isSkipped(pr(1, { headRefName: 'release/1', author: 'app/dependabot' }), custom), false)
  })
})

describe('entryLine', () => {
  it('#<番号> (説明) を / で並べる', () => {
    assert.equal(entryLine([{ number: 12, title: 'feat: 12 番' }, { number: 30, title: 'docs: 30 番' }]), '#12 (feat: 12 番) / #30 (docs: 30 番)')
  })

  it('題の末尾の (#N) は括弧ごと外し、残りの #N は番号だけにする。別の issue への言及を足さないため', () => {
    assert.equal(describeTitle('feat: 設定を直す (#789)'), 'feat: 設定を直す')
    assert.equal(describeTitle('fix: x (#1、#2)'), 'fix: x')
    assert.equal(describeTitle('fix: x ( #1, #2 )'), 'fix: x')
    assert.equal(describeTitle('#7 を直す'), '7 を直す')
    assert.equal(describeTitle('a (b) c'), 'a (b) c')
  })

  it('題の @ は外す。メンションの通知にならないため。改行は空白にする', () => {
    assert.equal(describeTitle('@someone に聞く'), 'someone に聞く')
    assert.equal(describeTitle('a\nb\r\n  c'), 'a b c')
  })

  it('60 字で切り、切った所で開いている括弧は閉じる', () => {
    assert.equal(describeTitle('あ'.repeat(70)), `${'あ'.repeat(60)}…`)
    assert.equal(describeTitle(`(${'あ'.repeat(70)})`), `(${'あ'.repeat(59)}…)`)
    assert.equal(describeTitle('あ'.repeat(60)), 'あ'.repeat(60))
  })
})

describe('updateBody', () => {
  const entries = [{ number: 12, title: 'feat: 12 番' }, { number: 30, title: 'docs: 30 番' }]
  const block = (line: string, eol = '\n') => [START, `進行中の PR (自動): ${line}`, END].join(eol)
  const LINE = '#12 (feat: 12 番) / #30 (docs: 30 番)'
  const updated = (result: BodyUpdate): string => {
    assert.equal(result.kind, 'updated')
    return result.kind === 'updated' ? result.body : ''
  }

  it('印が無ければ、本文の最後に印の組を足す。元の本文は 1 文字も変えない (先頭の空行も、末尾の改行も)', () => {
    const body = '\n\n## 達成目標\n\n本文\n'
    assert.equal(updated(updateBody(body, entries)), `${body}\n${block(LINE)}\n`)
    assert.equal(updated(updateBody('', entries)), `${block(LINE)}\n`)
    assert.equal(updated(updateBody('改行なし', entries)), `改行なし\n\n${block(LINE)}\n`)
  })

  it('印があれば、印の間だけを書き換え、前と後ろは 1 文字も変えない (後ろの見出し、小見出し、# の行、署名の行も)', () => {
    const tail = '\n\n## 後の見出し\n### 小見出し\n注記\n# レベル 1\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
    const body = `前の文\n\n${block('#1 (古い)')}${tail}`
    assert.equal(updated(updateBody(body, entries)), `前の文\n\n${block(LINE)}${tail}`)
  })

  it('人が書いた「## 進行中の PR」の節は触らない。印の組は、その後ろに足す', () => {
    const body = '## 進行中の PR\n\n#1 (Draft、オーナーのレビュー待ち)\n\n## 次\n\n文\n'
    const result = updated(updateBody(body, entries))
    assert.ok(result.startsWith(body))
    assert.equal(result, `${body}\n${block(LINE)}\n`)
  })

  it('コードの囲み (```) の中にある印は、数えない。囲みは壊さない', () => {
    const body = `印の書き方:\n\`\`\`\n${START}\n${END}\n\`\`\`\n`
    assert.equal(updated(updateBody(body, entries)), `${body}\n${block(LINE)}\n`)
  })

  it('行の途中にある印の文字は、印にしない', () => {
    const body = `文 ${START} 文\n`
    assert.equal(updated(updateBody(body, entries)), `${body}\n${block(LINE)}\n`)
  })

  it('印が壊れている本文 (片方だけ、2 組以上、順が逆) は、書き換えない', () => {
    assert.deepEqual(updateBody(`前\n${START}\n後\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`前\n${END}\n後\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`${block('a')}\n${block('b')}\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`${END}\n${START}\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`${START}\n`, []), { kind: 'broken' })
    assert.deepEqual(updateBody(`${START}\n${START}\n${END}\n`, entries), { kind: 'broken' })
    assert.deepEqual(updateBody(`${START}\n${END}\n${END}\n`, entries), { kind: 'broken' })
  })

  it('同じ内容なら、変わらない (2 回流しても書き換えない)', () => {
    const once = updated(updateBody('本文\n', entries))
    assert.deepEqual(updateBody(once, entries), { kind: 'unchanged' })
    const middle = updated(updateBody('本文\n\n## 次\n\n文\n', entries))
    assert.deepEqual(updateBody(middle, entries), { kind: 'unchanged' })
  })

  it('entries が空なら、印の組を消す。前後の本文は変えない。印が無ければ、何もしない', () => {
    assert.equal(updated(updateBody(`前\n\n${block('#1 (古い)')}\n\n後\n`, [])), '前\n\n後\n')
    assert.equal(updated(updateBody(`前\n\n${block('#1 (古い)')}\n`, [])), '前\n')
    assert.equal(updated(updateBody(`${block('#1 (古い)')}\n`, [])), '')
    assert.equal(updated(updateBody(`${block('#1 (古い)')}\n\n後\n`, [])), '後\n')
    assert.deepEqual(updateBody('前\n', []), { kind: 'unchanged' })
  })

  it('足してから消すと、元の本文に戻る', () => {
    const body = '本文\n\n## 次\n\n文\n'
    assert.equal(updated(updateBody(updated(updateBody(body, entries)), [])), body)
  })

  it('改行が CRLF の本文は、CRLF で書く', () => {
    const body = '前\r\n\r\n文\r\n'
    assert.equal(updated(updateBody(body, entries)), `${body}\r\n${block(LINE, '\r\n')}\r\n`)
    const withBlock = `前\r\n\r\n${block('#1 (古い)', '\r\n')}\r\n\r\n後\r\n`
    assert.equal(updated(updateBody(withBlock, entries)), `前\r\n\r\n${block(LINE, '\r\n')}\r\n\r\n後\r\n`)
  })
})

describe('planLinks', () => {
  const plain = (number: number, body = '目標\n') => ({ number, body })
  const withBlock = (number: number, line: string) => ({ number, body: `目標\n\n${START}\n進行中の PR (自動): ${line}\n${END}\n` })

  it('開いている issue ごとに、指す PR を並べる。PR の番号や、開いていない issue は、足す先が無い', () => {
    const prs = [pr(50, { title: 'feat: a (#10)' }), pr(40, { body: 'Closes #10 と #11', headRefName: 'topic' }), pr(60, { body: 'Refs #999\nCloses #50', headRefName: 'topic' })]
    const { plans } = planLinks('example-org/app', prs, [plain(10), plain(11), withBlock(12, '#99 (閉じた PR)')], links)
    assert.deepEqual(plans.map((plan) => [plan.issue, plan.entries.map((entry) => entry.number)]), [[10, [40, 50]], [11, [40]], [12, []]])
  })

  it('計画は、元の本文 (before) と新しい本文 (after) を持つ', () => {
    const { plans } = planLinks('r/x', [pr(50, { title: 'docs: a (#10)', headRefName: 'topic' })], [plain(10)], links)
    assert.equal(plans[0]?.before, '目標\n')
    assert.equal(plans[0]?.after, `目標\n\n${START}\n進行中の PR (自動): #50 (docs: a)\n${END}\n`)
  })

  it('変わらない issue は計画に入れない。PR が無くなった issue は、印の組を消す計画になる', () => {
    const prs = [pr(50, { title: 'docs: a (#10)', headRefName: 'topic' })]
    const first = planLinks('r/x', prs, [plain(10)], links).plans[0]
    assert.deepEqual(planLinks('r/x', prs, [{ number: 10, body: first?.after ?? '' }], links), { plans: [], broken: [] })
    const removed = planLinks('r/x', [], [withBlock(12, '#99 (閉じた PR)')], links).plans
    assert.equal(removed[0]?.after, '目標\n')
  })

  it('issue の一覧が新しい順 (gh の実際の返し方) でも、計画は番号の小さい順', () => {
    const prs = [pr(50, { body: 'Closes #10\nCloses #11\nCloses #12', headRefName: 'topic' })]
    const { plans } = planLinks('r/x', prs, [plain(12), plain(10), plain(11)], links)
    assert.deepEqual(plans.map((plan) => plan.issue), [10, 11, 12])
  })

  it('印が壊れている issue は、計画に入れず、broken に番号を返す', () => {
    const prs = [pr(50, { body: 'Closes #10\nCloses #11', headRefName: 'topic' })]
    const planning = planLinks('r/x', prs, [plain(11), { number: 10, body: `${START}\n文\n` }], links)
    assert.deepEqual(planning.plans.map((plan) => plan.issue), [11])
    assert.deepEqual(planning.broken, [10])
  })

  it('Dependabot と release/ の PR は数えない', () => {
    const prs = [pr(50, { body: 'Closes #10', author: 'app/dependabot' }), pr(51, { body: 'Closes #10', headRefName: 'release/1' })]
    assert.deepEqual(planLinks('r/x', prs, [plain(10)], links).plans, [])
  })

  it('閉じていないコードの囲みがある本文は、足した印が囲みの中に入って読めないので、計画に入れず、broken に出す (流すたびに印の組が足されるのを防ぐ)', () => {
    const prs = [pr(50, { body: 'Closes #10\nCloses #11', headRefName: 'topic' })]
    const open = { number: 10, body: '手順:\n```sh\nscrum link-prs\n' }
    const planning = planLinks('r/x', prs, [open, plain(11)], links)
    assert.deepEqual(planning.plans.map((plan) => plan.issue), [11])
    assert.deepEqual(planning.broken, [10])
  })

  it('PR の本文の途中の #N (文脈のために書いた番号) には、その PR を並べない', () => {
    const prs = [pr(50, { body: '背景は #10 の続き。\nCloses #11', headRefName: 'topic' })]
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
  const AFTER_10 = `目標\n\n${START}\n進行中の PR (自動): #50 (docs: a)\n${END}\n`

  /** gh の偽物。issues は一覧が返す本文、current は書く直前の読み直しが返す本文 (無ければ一覧と同じ)。PATCH は記録する。 */
  function fake(issues: readonly { number: number; body: string }[], current: Record<number, { state: string; body: string } | 'FAIL'> = {}, onPatch?: (args: readonly string[]) => void): GhRun {
    return (args) => {
      calls.push(args)
      if (args[0] === 'pr') return prList
      if (args[0] === 'issue') return JSON.stringify(issues)
      if (args[0] !== 'api') throw new Error('想定していない呼び出し')
      if (args[1] === '-X') {
        onPatch?.(args)
        return '{}'
      }
      const number = Number(args[1]?.split('/').pop())
      const now = current[number] ?? { state: 'open', body: issues.find((one) => one.number === number)?.body ?? '' }
      if (now === 'FAIL') throw new Error('gh が失敗')
      return JSON.stringify(now)
    }
  }
  const patches = () => calls.filter((args) => args[1] === '-X')

  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-links-')))
    calls = []
  })

  const withRepos = (repos: readonly string[], overrides: Partial<LinksConfig> = {}) => ({ ...config, repos, links: { ...links, ...overrides } })

  it('PR と issue を読み、本文が変わる issue を、書く直前に読み直してから、PATCH で書き換える。本文は -f で渡す', () => {
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, fake([{ number: 10, body: '目標\n' }]), { dryRun: false })
    assert.equal(result.applied.length, 1)
    assert.deepEqual(patches(), [['api', '-X', 'PATCH', 'repos/example-org/app/issues/10', '-f', `body=${AFTER_10}`]])
    const indexOf = (predicate: (args: readonly string[]) => boolean) => calls.findIndex(predicate)
    assert.ok(indexOf((args) => args[0] === 'api' && args[1] === 'repos/example-org/app/issues/10') < indexOf((args) => args[1] === '-X'))
    assert.match(readFileSync(p.events, 'utf8'), /"type":"link-prs","repo":"example-org\/app","issue":10,"prs":\[50\]/)
  })

  it('本文が @ で始まる issue でも、本文はファイルとして読まれない形 (-f) で渡す', () => {
    linkPullRequests(p, withRepos(['r/x']), NOW, fake([{ number: 10, body: '@someone\n' }]), { dryRun: false })
    assert.equal(patches()[0]?.[4], '-f')
    assert.ok(patches()[0]?.[5]?.startsWith('body=@someone\n'))
  })

  it('書く前の本文は、書く前に log/links-before.jsonl に残す', () => {
    let beforeLog = ''
    linkPullRequests(p, withRepos(['example-org/app']), NOW, fake([{ number: 10, body: '目標\n' }], {}, () => { beforeLog = readFileSync(p.linksBefore, 'utf8') }), { dryRun: false })
    assert.deepEqual(JSON.parse(beforeLog.trim()), { at: NOW.toISOString(), repo: 'example-org/app', issue: 10, body: '目標\n' })
  })

  it('読み直した本文が、計画を作ったときと違えば (人が直した)、書かない。理由を記録し、元の本文は残さない', () => {
    const run = fake([{ number: 10, body: '目標\n' }], { 10: { state: 'open', body: '目標\n人が足した一文\n' } })
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, run, { dryRun: false })
    assert.deepEqual([result.applied.length, result.skipped.map((one) => one.reason)], [0, ['changed']])
    assert.equal(patches().length, 0)
    assert.match(readFileSync(p.events, 'utf8'), /"type":"link-skipped","repo":"example-org\/app","issue":10,"reason":"changed"/)
    assert.throws(() => readFileSync(p.linksBefore, 'utf8'), /ENOENT/)
  })

  it('読み直したときに、issue が閉じていれば、書かない', () => {
    const run = fake([{ number: 10, body: '目標\n' }], { 10: { state: 'closed', body: '目標\n' } })
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, run, { dryRun: false })
    assert.deepEqual(result.skipped.map((one) => one.reason), ['closed'])
    assert.equal(patches().length, 0)
  })

  it('1 つの issue の読み直しが失敗しても、記録して、次の issue は進める', () => {
    const issues = [{ number: 10, body: '目標\n' }, { number: 11, body: '目標\n' }]
    const prs = JSON.stringify([{ number: 50, title: 'docs: a', body: 'Closes #10\nCloses #11', headRefName: 'topic', author: { login: 'a' } }])
    const base = fake(issues, { 10: 'FAIL' })
    const run: GhRun = (args) => (args[0] === 'pr' ? prs : base(args))
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, run, { dryRun: false })
    assert.deepEqual([result.applied.map((plan) => plan.issue), result.skipped.map((one) => one.reason)], [[11], ['failed']])
    assert.match(readFileSync(p.errors, 'utf8'), /link-prs example-org\/app#10: gh が失敗/)
  })

  it('dryRun は、予定だけを返し、読み直しも書き換えもしない', () => {
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, fake([{ number: 10, body: '目標\n' }]), { dryRun: true })
    assert.deepEqual([result.planned.length, result.applied.length], [1, 0])
    assert.equal(calls.some((args) => args[0] === 'api'), false)
  })

  it('1 回に書き換えるのは maxEditsPerRun 件まで。gh が新しい順に返しても、番号の小さい順に当てる', () => {
    const newestFirst = [14, 13, 12, 11, 10].map((number) => ({ number, body: '目標\n' }))
    const prs = JSON.stringify([{ number: 50, title: 't', body: 'Closes #10 #11 #12 #13 #14', headRefName: 'topic', author: { login: 'a' } }])
    const base = fake(newestFirst)
    const run: GhRun = (args) => (args[0] === 'pr' ? prs : base(args))
    const result = linkPullRequests(p, withRepos(['r/x'], { maxEditsPerRun: 2 }), NOW, run, { dryRun: false })
    assert.deepEqual(result.applied.map((plan) => plan.issue), [10, 11])
    assert.deepEqual(result.planned.map((plan) => plan.issue), [10, 11, 12, 13, 14])
  })

  it('1 回に書き換える上限 maxEditsPerRun は、リポジトリ全体で数える (リポジトリごとではない)', () => {
    const issues = [10, 11, 12].map((number) => ({ number, body: '目標\n' }))
    const prs = JSON.stringify([{ number: 50, title: 't', body: 'Closes #10 #11 #12', headRefName: 'topic', author: { login: 'a' } }])
    const base = fake(issues)
    const run: GhRun = (args) => (args[0] === 'pr' ? prs : base(args))
    const result = linkPullRequests(p, withRepos(['r/a', 'r/b'], { maxEditsPerRun: 4 }), NOW, run, { dryRun: false })
    assert.deepEqual(result.applied.map((plan) => `${plan.repo}#${plan.issue}`), ['r/a#10', 'r/a#11', 'r/a#12', 'r/b#10'])
    assert.equal(result.planned.length, 6)
  })

  it('上限には、飛ばした分 (人が直した) も数える。飛ばした分だけ、次のリポジトリの枠が減る', () => {
    const issues = [10, 11].map((number) => ({ number, body: '目標\n' }))
    const prs = JSON.stringify([{ number: 50, title: 't', body: 'Closes #10 #11', headRefName: 'topic', author: { login: 'a' } }])
    const base = fake(issues, { 10: { state: 'open', body: '人が直した\n' } })
    const run: GhRun = (args) => (args[0] === 'pr' ? prs : base(args))
    const result = linkPullRequests(p, withRepos(['r/a', 'r/b'], { maxEditsPerRun: 2 }), NOW, run, { dryRun: false })
    assert.deepEqual(result.applied.map((plan) => `${plan.repo}#${plan.issue}`), ['r/a#11'])
    assert.deepEqual(result.skipped.map((one) => `${one.plan.repo}#${one.plan.issue}`), ['r/a#10'])
  })

  it('印が壊れた issue は、書き換えず、結果と記録に出す', () => {
    const result = linkPullRequests(p, withRepos(['example-org/app']), NOW, fake([{ number: 10, body: `${START}\n文\n` }]), { dryRun: false })
    assert.deepEqual(result.broken, [{ repo: 'example-org/app', issue: 10 }])
    assert.equal(patches().length, 0)
    assert.match(readFileSync(p.events, 'utf8'), /"type":"link-broken","repo":"example-org\/app","issue":10/)
  })

  it('読むのに失敗したリポジトリは、記録して飛ばし、ほかのリポジトリは進める', () => {
    const base = fake([{ number: 10, body: '目標\n' }])
    const run: GhRun = (args) => {
      if (args.includes('bad/repo')) throw new Error('gh が失敗')
      return base(args)
    }
    const result = linkPullRequests(p, withRepos(['bad/repo', 'example-org/app']), NOW, run, { dryRun: false })
    assert.equal(result.applied.length, 1)
    assert.match(readFileSync(p.errors, 'utf8'), /link-prs bad\/repo: gh が失敗/)
  })

  it('PR の一覧の読み方: 読めない項目 (番号が数でない) は捨てる', () => {
    assert.deepEqual(listOpenPrs(() => prList, 'r/x').map((one) => one.number), [50, 51])
  })
})

describe('isLinksDue と runLinksIfDue', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-links-due-')))
  })
  const enabled = { ...config, repos: ['example-org/app'], links }
  const quiet: GhRun = (args) => (args[0] === 'api' ? '{}' : '[]')

  it('links が無いか無効なら、流さない。間隔 (既定 30 分) が過ぎるまで、2 回目は流さない', () => {
    assert.equal(isLinksDue(p, config, NOW), false)
    assert.equal(isLinksDue(p, { ...config, links: { ...links, enabled: false } }, NOW), false)
    assert.equal(isLinksDue(p, enabled, NOW), true)
    assert.notEqual(runLinksIfDue(p, enabled, NOW, quiet), null)
    assert.equal(runLinksIfDue(p, enabled, new Date(NOW.getTime() + 29 * 60_000), quiet), null)
    assert.notEqual(runLinksIfDue(p, enabled, new Date(NOW.getTime() + 30 * 60_000), quiet), null)
  })

  it('錠を別の生きているプロセスが持っていれば、流さず、時刻も書かない', () => {
    mkdirSync(dirname(p.linksLock), { recursive: true })
    writeFileSync(p.linksLock, String(process.ppid))
    assert.equal(runLinksIfDue(p, enabled, NOW, quiet), null)
    assert.equal(readJson(p.linksState, null), null)
  })

  it('流したら、流した時刻を書く (失敗しても、間隔のうちは試さない)', () => {
    runLinksIfDue(p, enabled, NOW, () => {
      throw new Error('gh が失敗')
    })
    assert.equal(readJson(p.linksState, null), NOW.toISOString())
    assert.equal(isLinksDue(p, enabled, new Date(NOW.getTime() + 60_000)), false)
  })
})

describe('parseLinks', () => {
  it('enabled だけで、ほかは既定で埋める', () => {
    assert.deepEqual(parseLinks({ enabled: true }), { ...DEFAULT_LINKS, enabled: true })
  })

  it('形が違えば、この機能だけを止める', () => {
    const bad = [null, 'x', {}, { enabled: 1 }, { enabled: true, intervalMinutes: 0 }, { enabled: true, maxEditsPerRun: 1.5 }, { enabled: true, skipAuthors: 'a' }]
    bad.forEach((raw) => assert.equal(parseLinks(raw), undefined, JSON.stringify(raw)))
  })

  it('設定ファイルの links が壊れていても、設定全体は読める', () => {
    assert.equal(parseConfig({ ...config, links: { enabled: 'x' } })?.links, undefined)
    assert.equal(parseConfig({ ...config, links: { enabled: true } })?.links?.enabled, true)
  })
})

describe('TechLead の待機', async () => {
  const { runWatch } = await import('../src/watch.ts')
  const { saveSnapshot } = await import('../src/board/snapshot.ts')
  const { snapshot } = await import('./helpers.ts')

  it('links が有効なら、待機の 1 周で、開いている PR を読む (間隔の内は、2 周目で読まない)', async () => {
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

  it('links が無ければ、gh を呼ばない', async () => {
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
