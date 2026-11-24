import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { parseConfig } from '../src/config.ts'
import { readDispatches } from '../src/dispatch/records.ts'
import { branchName, ensureLinkedBranch, LINK_GH_TIMEOUT_MS, linkBranchWith, parseLookup, type GhRun, type LinkBranch } from '../src/dispatch/linked-branch.ts'
import { ghWithin } from '../src/github.ts'
import { dispatchMessage } from '../src/dispatch/message.ts'
import { dispatchStep, type Exec } from '../src/dispatch/run.ts'
import { paths, type Paths } from '../src/store.ts'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

/** gh の印を読まない (本物の gh を呼ばない) */
const noProbe = () => null

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
      if (next === undefined) throw new Error('想定していない呼び出し')
      if (next === 'FAIL') throw new Error('gh が失敗')
      return next
    },
  }
}

describe('parseLookup', () => {
  it('リポジトリと issue の ID、紐づいたブランチ、ベースの先頭を読む', () => {
    const linked = lookup({ issue: { id: 'I_9', linkedBranches: { nodes: [{ ref: { name: 'feat/9' } }, { ref: null }] } } })
    assert.deepEqual(parseLookup(linked), { repositoryId: 'R_1', issueId: 'I_9', linked: ['feat/9'], oid: 'abc123' })
  })

  it('読めない形は、理由を付けて投げる', () => {
    assert.throws(() => parseLookup(JSON.stringify({ data: { repository: null } })), /リポジトリを読めない/)
    assert.throws(() => parseLookup(lookup({ id: '' })), /リポジトリの ID/)
    assert.throws(() => parseLookup(lookup({ issue: null })), /issue が無い/)
    assert.throws(() => parseLookup(lookup({ ref: null })), /ベースのブランチが無い/)
    assert.throws(() => parseLookup('壊れた'))
  })
})

describe('ensureLinkedBranch', () => {
  const input = { repo: 'example-org/app', number: 123, baseBranch: 'develop', prefix: 'feat' }

  it('紐づいたブランチが無ければ、ベースの先頭の oid から feat/<番号> を作る', () => {
    const { run, calls } = fakeGh([lookup(), '{}'])
    assert.deepEqual(ensureLinkedBranch(run, input), { name: 'feat/123', isNew: true })
    const query = calls[0] ?? []
    assert.ok(query.includes('owner=example-org') && query.includes('name=app') && query.includes('number=123') && query.includes('ref=refs/heads/develop'))
    // number は GraphQL の Int! なので、-F (型を読む) で渡す。-f だと文字列になり、問い合わせが毎回失敗する
    assert.equal(query[query.indexOf('number=123') - 1], '-F')
    const stringArgs = ['owner=example-org', 'name=app', 'ref=refs/heads/develop']
    stringArgs.forEach((arg) => assert.equal(query[query.indexOf(arg) - 1], '-f', arg))
    const mutation = calls[1] ?? []
    assert.ok(['issue=I_1', 'oid=abc123', 'name=feat/123', 'repo=R_1'].every((arg) => mutation.includes(arg)))
    assert.ok(mutation.some((arg) => arg.startsWith('query=mutation') && arg.includes('createLinkedBranch')))
    ;['issue=I_1', 'oid=abc123', 'name=feat/123', 'repo=R_1'].forEach((arg) => assert.equal(mutation[mutation.indexOf(arg) - 1], '-f', arg))
  })

  it('すでに紐づいたブランチがあれば、作らずにそれを返す', () => {
    const { run, calls } = fakeGh([lookup({ issue: { id: 'I_1', linkedBranches: { nodes: [{ ref: { name: 'feat/old-name' } }] } } })])
    assert.deepEqual(ensureLinkedBranch(run, input), { name: 'feat/old-name', isNew: false })
    assert.equal(calls.length, 1)
  })

  it('紐づいたブランチが複数あれば、最初のものを返す (作らない)', () => {
    const nodes = [{ ref: { name: 'feat/first' } }, { ref: { name: 'feat/second' } }]
    const { run, calls } = fakeGh([lookup({ issue: { id: 'I_1', linkedBranches: { nodes } } })])
    assert.deepEqual(ensureLinkedBranch(run, input), { name: 'feat/first', isNew: false })
    assert.equal(calls.length, 1)
  })

  it('作るのに失敗したら、投げる (同じ名前のブランチがすでにあるときなど)', () => {
    const { run } = fakeGh([lookup(), 'FAIL'])
    assert.throws(() => ensureLinkedBranch(run, input), /gh が失敗/)
  })

  it('ブランチ名は <prefix>/<番号>', () => {
    assert.equal(branchName('fix', 7), 'fix/7')
  })
})

describe('linkBranchWith', () => {
  it('linkedBranchPrefix が無ければ、gh を呼ばず null', () => {
    const { run, calls } = fakeGh([])
    assert.equal(linkBranchWith(run)(issue(11), { ...config, dispatch: { ...withPrefix.dispatch, linkedBranchPrefix: undefined } }), null)
    assert.equal(calls.length, 0)
  })

  it('番号の無い項目 (下書き) は null', () => {
    const { run, calls } = fakeGh([])
    assert.equal(linkBranchWith(run)(issue(11, { number: null }), withPrefix), null)
    assert.equal(calls.length, 0)
  })

  it('項目のリポジトリと、設定の baseBranch を使う', () => {
    const { run, calls } = fakeGh([lookup(), '{}'])
    assert.deepEqual(linkBranchWith(run)(issue(11), withPrefix), { name: 'feat/11', isNew: true })
    assert.ok((calls[0] ?? []).includes('owner=example-org') && (calls[0] ?? []).includes('ref=refs/heads/develop'))
  })
})

describe('dispatchMessage のブランチの行', () => {
  const item = issue(11, { title: '次の仕事', repo: 'example-org/app' })

  it('作ったブランチは、名前、ベース、PR の本文に番号を書くことを伝える', () => {
    const text = dispatchMessage(item, 'SWE1', withPrefix, { name: 'feat/11', isNew: true })
    assert.match(text, /- issue に紐づいたブランチ feat\/11 を、origin\/develop の先頭から作ってある。git fetch origin してから/)
    assert.match(text, /- PR の本文には #11 を書く \(PR から issue に飛べる\)/)
  })

  it('すでにあったブランチは、そう書き、土台が古いことがあるので、origin/develop に遅れていないかを見てから作業させる', () => {
    const text = dispatchMessage(item, 'SWE1', withPrefix, { name: 'feat/old', isNew: false })
    assert.match(text, /ブランチ feat\/old は、すでにあったもの。土台が古いことがあるので、git fetch origin のあと、git log feat\/old\.\.origin\/develop で origin\/develop に遅れていないかを見てから、このブランチで作業し/)
    assert.doesNotMatch(dispatchMessage(item, 'SWE1', withPrefix, { name: 'feat/11', isNew: true }), /遅れていないか|すでにあった/)
  })

  it('用意できなかったときは、自分で切ることと、本文に番号を書くことを伝える', () => {
    assert.match(dispatchMessage(item, 'SWE1', withPrefix, 'failed'), /紐づいたブランチは用意できなかった \(記録は errors.log\)。自分でブランチを切り、PR の本文に #11 を書く/)
  })

  it('ブランチを扱わない設定 (null) では、今までの文面のまま', () => {
    const text = dispatchMessage(item, 'SWE1', withPrefix, null)
    assert.doesNotMatch(text, /ブランチ|本文には/)
    assert.equal(text, dispatchMessage(item, 'SWE1', withPrefix))
  })
})

describe('parseConfig の linkedBranchPrefix', () => {
  const parse = (prefix: unknown) => parseConfig({ ...config, dispatch: { enabled: true, linkedBranchPrefix: prefix } })?.dispatch

  it('英数字、ドット、ハイフン、アンダースコアと、/ で区切った名前を受け入れる', () => {
    assert.equal(parse('feat')?.linkedBranchPrefix, 'feat')
    assert.equal(parse('feat/auto')?.linkedBranchPrefix, 'feat/auto')
  })

  it('空、空白、先頭や末尾の /、文字列でない値は、dispatch の設定ごと使わない', () => {
    for (const bad of ['', 'a b', '/feat', 'feat/', 'feat//x', 3, '日本語']) assert.equal(parse(bad), undefined, String(bad))
  })

  it('書かなければ、無いまま', () => {
    assert.equal(parseConfig({ ...config, dispatch: { enabled: true } })?.dispatch?.linkedBranchPrefix, undefined)
  })
})

describe('dispatchStep のブランチ', () => {
  let p: Paths
  const exec: Exec = () => undefined
  const board = () => saveSnapshot(p, snapshot([issue(11, { status: '次にやる', title: '次の仕事' })]))

  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-link-')))
    process.env.SCRUM_SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'scrum-sessions-'))
    writeHeartbeat(p, { sessionId: 'session-SWE1', name: 'SWE1', pid: null }, 'idle', new Date(NOW.getTime() - 20 * 60_000))
    board()
  })

  afterEach(() => {
    delete process.env.SCRUM_SESSIONS_DIR
  })

  it('紐づいたブランチを用意し、記録と文面に残す', () => {
    const link: LinkBranch = () => ({ name: 'feat/11', isNew: true })
    const outcome = dispatchStep(p, withPrefix, 'SWE1', NOW, exec, noProbe, link)
    assert.match(outcome?.message ?? '', /ブランチ feat\/11 を、origin\/develop の先頭から作ってある/)
    assert.equal(outcome?.record.branch, 'feat/11')
    assert.equal(readDispatches(p)[0]?.branch, 'feat/11')
    assert.match(readFileSync(p.events, 'utf8'), /"branch":"feat\/11"/)
  })

  it('用意に失敗しても、渡すことは止めない。失敗は記録し、文面に書く', () => {
    const link: LinkBranch = () => {
      throw new Error('ブランチを作れない')
    }
    const outcome = dispatchStep(p, withPrefix, 'SWE1', NOW, exec, noProbe, link)
    assert.match(outcome?.message ?? '', /紐づいたブランチは用意できなかった/)
    assert.equal(outcome?.record.branch, undefined)
    assert.match(readFileSync(p.errors, 'utf8'), /dispatch-link: ブランチを作れない/)
    assert.equal(readDispatches(p).length, 1)
  })

  it('ブランチを扱わない設定では、用意の呼び出しの結果 (null) を文面に出さない', () => {
    const outcome = dispatchStep(p, withPrefix, 'SWE1', NOW, exec, noProbe, () => null)
    assert.doesNotMatch(outcome?.message ?? '', /ブランチ feat|用意できなかった/)
    assert.equal(outcome?.record.branch, undefined)
  })

  it('既定の呼び出しは、linkedBranchPrefix が無ければ gh を呼ばない (今までの動き)', () => {
    const plain = { ...withPrefix, dispatch: { ...withPrefix.dispatch, linkedBranchPrefix: undefined } }
    const outcome = dispatchStep(p, plain, 'SWE1', NOW, exec)
    assert.match(outcome?.message ?? '', /^scrum-harness: SWE1 に次の仕事を渡した/)
    assert.doesNotMatch(outcome?.message ?? '', /ブランチ feat/)
  })

  it('促しの文面は、ブランチを用意しない', () => {
    saveSnapshot(p, snapshot([issue(12, { status: '作業中', tanto: 'SWE1', title: '進行中' })]))
    let called = false
    const outcome = dispatchStep(p, withPrefix, 'SWE1', NOW, exec, noProbe, () => {
      called = true
      return null
    })
    assert.match(outcome?.message ?? '', /進める/)
    assert.equal(called, false)
  })
})

describe('渡す錠の中の gh の打ち切り', () => {
  it('1 回の gh は 15 秒で打ち切る。最大 2 回なので、錠を持つのは 30 秒まで', () => {
    assert.equal(LINK_GH_TIMEOUT_MS, 15_000)
  })

  it('ghWithin は、指定した時間を過ぎた gh を打ち切って投げる', () => {
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
