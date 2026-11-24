import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseBoardCommands, shellPatterns } from '../src/adapters/github/action-reader.ts'
import { referencedLabels } from '../src/adapters/github/pull-requests.ts'
import { applyCommands, checkGuard, mergeContext } from '../src/board/commands.ts'
import { config, issue, pr, snapshot } from './helpers.ts'

const parse = (command: string) => parseBoardCommands(command, config)

describe('parseBoardCommands', () => {
  it('set-status の番号と Status を読む', () => {
    assert.deepEqual(parse('./set-status 123 作業中'), [
      { kind: 'set-status', label: 'app#123', status: '作業中' },
    ])
  })

  it('英語の Status を日本語に揃える', () => {
    assert.deepEqual(parse('./set-status 5 InProgress'), [{ kind: 'set-status', label: 'app#5', status: '作業中' }])
  })

  it('&& でつないだ複数のコマンドを読む', () => {
    const commands = parse('cd t && ./set-status 1 Done && ./set-tanto 1 なし; ./set-reason 2 外部待ち 2026-10-07')
    assert.deepEqual(commands, [
      { kind: 'set-status', label: 'app#1', status: '完了' },
      { kind: 'set-tanto', label: 'app#1', tanto: null },
      { kind: 'set-reason', label: 'app#2', reason: '外部待ち', since: '2026-10-07' },
    ])
  })

  it('引用符で囲んだ担当の名前を読む', () => {
    assert.deepEqual(parse('set-tanto 9 "別のセッション"'), [
      { kind: 'set-tanto', label: 'app#9', tanto: '別のセッション' },
    ])
  })

  it('bulk-status の Status と対象を読む', () => {
    assert.deepEqual(parse('bulk-status リリース待ち app#1 app#2'), [
      { kind: 'bulk-status', labels: ['app#1', 'app#2'], status: 'リリース待ち' },
    ])
  })

  it('merge-pr と gh pr merge と gh issue close を読む', () => {
    assert.deepEqual(parse('merge-pr example-org/app 210 abc123'), [
      { kind: 'merge-pr', label: 'app#210', repo: 'example-org/app' },
    ])
    assert.deepEqual(parse('gh pr merge 22 -R example-org/app-mobile --squash'), [
      { kind: 'merge-pr', label: 'app-mobile#22', repo: 'example-org/app-mobile' },
    ])
    // merge-pr のスクリプトの形 (スクリプトの名前、リポジトリ、番号) も、指したリポジトリのまま持つ
    assert.deepEqual(parse('merge-pr other-owner/tool 3 abc123'), [{ kind: 'merge-pr', label: 'tool#3', repo: 'other-owner/tool' }])
    // 設定の repos に無いリポジトリは、defaultRepo に取り違えず、指したリポジトリのまま持つ
    assert.deepEqual(parse('gh pr merge 3 -R other-owner/tool --squash'), [{ kind: 'merge-pr', label: 'tool#3', repo: 'other-owner/tool' }])
    assert.deepEqual(parse('gh issue close 11 --comment done'), [{ kind: 'close-issue', label: 'app#11' }])
  })

  it('スクリプトを通さないボードの書き換えを raw-mutation とする', () => {
    assert.deepEqual(parse('gh project item-edit --id X --field-id Y --clear'), [{ kind: 'raw-mutation' }])
    assert.deepEqual(parse(`gh api graphql -f query='mutation{updateProjectV2ItemFieldValue(input:{})}'`), [
      { kind: 'raw-mutation' },
    ])
  })

  it('ボードに関係の無いコマンドは空', () => {
    assert.deepEqual(parse('git status && ls set-status.bak'), [])
  })
})

describe('applyCommands', () => {
  it('Status・理由・担当を控えに反映する', () => {
    const before = snapshot([issue(1)])
    const after = applyCommands(before, parse('set-status 1 作業中 && set-tanto 1 SWE1'), config, '2026-10-08')
    assert.deepEqual([after.items[0]?.status, after.items[0]?.tanto], ['作業中', 'SWE1'])
    assert.equal(before.items[0]?.status, 'バックログ')
  })

  it('理由を付けると今日を止まり始めた日にし、なしにすると日を消す', () => {
    const stopped = applyCommands(snapshot([issue(1)]), parse('set-reason 1 外部待ち'), config, '2026-10-08')
    assert.deepEqual([stopped.items[0]?.reason, stopped.items[0]?.since], ['外部待ち', '2026-10-08'])
    const resumed = applyCommands(stopped, parse('set-reason 1 なし'), config, '2026-10-08')
    assert.deepEqual([resumed.items[0]?.reason, resumed.items[0]?.since], ['なし', null])
  })

  it('閉じた issue とマージした PR の状態を変える', () => {
    const after = applyCommands(snapshot([issue(1), pr(2, { state: 'OPEN' })]), parse('gh issue close 1 && gh pr merge 2'), config, '2026-10-08')
    assert.deepEqual(after.items.map((item) => item.state), ['CLOSED', 'MERGED'])
  })

  it('ボードに無い issue の Status を変えると項目を足す', () => {
    const after = applyCommands(snapshot([]), parse('set-status 7 バックログ'), config, '2026-10-08')
    assert.deepEqual(after.items.map((item) => [item.number, item.status]), [[7, 'バックログ']])
  })
})

describe('checkGuard', () => {
  const full = snapshot(Array.from({ length: 10 }, (_, i) => issue(i + 1, { status: '作業中', tanto: 'SWE1' })))

  it('上限に達しているのに作業中を増やすと拒否する', () => {
    const reason = checkGuard(snapshot([...full.items, issue(50)]), parse('set-status 50 作業中'), config)
    assert.match(reason ?? '', /作業中は 10 件で上限/)
  })

  it('すでに作業中の issue を作業中にし直すのは許す', () => {
    assert.equal(checkGuard(full, parse('set-status 3 作業中'), config), null)
  })

  it('PR に Status を付けようとすると拒否する', () => {
    const reason = checkGuard(snapshot([pr(102)]), parse('set-status 102 作業中'), config)
    assert.match(reason ?? '', /PR に Status を付けない/)
  })

  it('SCRUM_GUARD=off があれば止めない', () => {
    const command = 'SCRUM_GUARD=off set-status 50 作業中'
    assert.equal(checkGuard(snapshot([...full.items, issue(50)]), parse(command), config, command), null)
  })
})

describe('referencedLabels と mergeContext', () => {
  it('本文の #番号 と リポジトリ名#番号 を拾う', () => {
    const body = '#11 の続き。app-mobile#22 も。https://x/y#4 は無視、Closes #230'
    assert.deepEqual(referencedLabels(body, 'example-org/app'), ['app#11', 'app-mobile#22', 'app#230'])
  })

  it('ボードにある issue の今の状態を並べる', () => {
    const board = snapshot([issue(11, { status: '作業中', tanto: 'SWE1' })])
    const text = mergeContext(board, 'app#220', ['app#11', 'app#999'], config) ?? ''
    assert.match(text, /app#220 をマージした/)
    assert.match(text, /app#11 Status=作業中 理由=なし 担当=SWE1/)
    assert.doesNotMatch(text, /app#999/)
  })

  it('ボードの issue に触れていなければ null', () => {
    assert.equal(mergeContext(snapshot([]), 'app#1', ['app#2'], config), null)
  })
})

describe('スクリプトの設定', () => {
  const bare = { ...config, scripts: {} }

  it('スクリプトを設定していなければ、スクリプトの呼び出しを読まない', () => {
    assert.deepEqual(parseBoardCommands('set-status 1 作業中 && merge-pr example-org/app 2', bare), [])
  })

  it('スクリプトを設定していなくても、gh のコマンドは読む', () => {
    assert.deepEqual(parseBoardCommands('gh issue close 3 && gh pr merge 4', bare), [
      { kind: 'close-issue', label: 'app#3' },
      { kind: 'merge-pr', label: 'app#4', repo: 'example-org/app' },
    ])
  })

  it('値を空にする語を設定していなければ、担当はそのまま読む', () => {
    const noClear = { ...config, scripts: { setTanto: 'set-tanto' } }
    assert.deepEqual(parseBoardCommands('set-tanto 9 なし', noClear), [{ kind: 'set-tanto', label: 'app#9', tanto: 'なし' }])
  })
})

describe('shellPatterns', () => {
  it('フックが node を起こすコマンドの型に、設定のスクリプト名を入れる', () => {
    const patterns = shellPatterns(config)
    assert.match('set-status 1 作業中', new RegExp(patterns.post))
    assert.match('gh pr merge 3', new RegExp(patterns.post))
    assert.doesNotMatch('git status', new RegExp(patterns.post))
    assert.match('bulk-status 作業中 app#1', new RegExp(patterns.pre))
    assert.doesNotMatch('set-reason 1 なし', new RegExp(patterns.pre))
  })

  it('スクリプト名の記号は型の中でそのまま扱う', () => {
    const patterns = shellPatterns({ ...config, scripts: { setStatus: 'update.sh' } })
    assert.doesNotMatch('updateXsh', new RegExp(patterns.pre))
  })

  it('Status を変えるスクリプトが無ければ、書き込みの前の確かめは要らない', () => {
    assert.equal(shellPatterns({ ...config, scripts: {} }).pre, '')
  })
})
