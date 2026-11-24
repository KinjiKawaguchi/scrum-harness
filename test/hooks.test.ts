import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSnapshot, saveSnapshot } from '../src/board/snapshot.ts'
import { handleHook, type HookDeps } from '../src/hooks/handlers.ts'
import { paths, readJson, writeJson, type Paths } from '../src/store.ts'
import { config, issue, NOW, pr, snapshot } from './helpers.ts'

let p: Paths
let refreshes = 0
let checkpoints = 0

function deps(name: string | null, overrides: Partial<HookDeps> = {}): HookDeps {
  return {
    p,
    config,
    now: NOW,
    identity: name === null ? null : { sessionId: `sid-${name}`, name, pid: null },
    fetchPrBody: () => '#1 の続き',
    spawnRefresh: () => {
      refreshes += 1
    },
    spawnCheckpoint: () => {
      checkpoints += 1
    },
    ...overrides,
  }
}

const context = (result: ReturnType<typeof handleHook>) =>
  (result.stdout as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput?.additionalContext ?? ''

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-hooks-')))
  process.env.SCRUM_SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'scrum-sessions-'))
  refreshes = 0
  checkpoints = 0
  saveSnapshot(p, snapshot([issue(1, { status: '作業中' }), issue(2), pr(102, { state: 'OPEN' })]))
})

describe('TechLead', () => {
  it('SessionStart で要約を入れ、知らせた指摘を覚える', () => {
    const result = handleHook('SessionStart', { session_id: 'sid', source: 'startup' }, deps('TechLead'))
    assert.match(context(result), /B-DOING-NO-TANTO app#1 は作業中なのに担当が無い/)
    assert.deepEqual(readJson(p.notified, []), ['B-DOING-NO-TANTO:app#1'])
  })

  it('UserPromptSubmit では知らせていない指摘だけを入れる', () => {
    handleHook('SessionStart', { source: 'startup' }, deps('TechLead'))
    assert.equal(context(handleHook('UserPromptSubmit', {}, deps('TechLead'))), '')
    saveSnapshot(p, snapshot([...(loadSnapshot(p)?.items ?? []), issue(3, { state: 'CLOSED', status: '作業中' })]))
    assert.match(context(handleHook('UserPromptSubmit', {}, deps('TechLead'))), /B-CLOSED-NOT-DONE app#3/)
  })

  it('set-status の後に控えを直し、その issue の指摘を入れる', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'set-status 2 作業中' } }
    const text = context(handleHook('PostToolUse', input, deps('TechLead')))
    assert.match(text, /app#2 は作業中なのに担当が無い/)
    assert.equal(loadSnapshot(p)?.items.find((item) => item.number === 2)?.status, '作業中')
  })

  it('マージの後に、本文が触れる issue の状態を入れる', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'merge-pr example-org/app 102' } }
    assert.match(context(handleHook('PostToolUse', input, deps('TechLead'))), /app#102 をマージした[\s\S]*app#1 Status=作業中/)
  })

  it('PR の本文は、コマンドが指したリポジトリで読む (設定に無いリポジトリを defaultRepo と取り違えない)', () => {
    const asked: (readonly [string, string])[] = []
    const input = { tool_name: 'Bash', tool_input: { command: 'gh pr merge 3 -R other-owner/tool --squash' } }
    handleHook('PostToolUse', input, deps('TechLead', { fetchPrBody: (prLabel, repo) => (asked.push([prLabel, repo]), null) }))
    assert.deepEqual(asked, [['tool#3', 'other-owner/tool']])
  })

  it('merge-pr のスクリプトの形のマージも、defaultRepo と違うリポジトリの PR は、そのリポジトリの本文を読み、案内を作る', () => {
    saveSnapshot(p, snapshot([...(loadSnapshot(p)?.items ?? []), { ...issue(1, { status: '作業中' }), repo: 'other-owner/tool' }]))
    const asked: (readonly [string, string])[] = []
    const input = { tool_name: 'Bash', tool_input: { command: 'merge-pr other-owner/tool 3 abc123' } }
    const text = context(
      handleHook('PostToolUse', input, deps('TechLead', { fetchPrBody: (prLabel, repo) => (asked.push([prLabel, repo]), '#1 の続き') })),
    )
    assert.deepEqual(asked, [['tool#3', 'other-owner/tool']])
    assert.match(text, /tool#3 をマージした[\s\S]*tool#1 Status=作業中/)
  })

  it('別のリポジトリの PR のマージは、本文が触れる番号を、そのリポジトリの issue として読む', () => {
    saveSnapshot(p, snapshot([...(loadSnapshot(p)?.items ?? []), { ...issue(1, { status: '作業中' }), repo: 'other-owner/tool' }]))
    const input = { tool_name: 'Bash', tool_input: { command: 'gh pr merge 3 -R other-owner/tool --squash' } }
    const text = context(handleHook('PostToolUse', input, deps('TechLead', { fetchPrBody: () => '#1 の続き' })))
    assert.match(text, /tool#3 をマージした[\s\S]*tool#1 Status=作業中/)
    assert.doesNotMatch(text, /tool#3 をマージした[\s\S]*app#1 Status/)
  })

  it('知らせたら、待機プロセスの印を消す', () => {
    writeJson(p.pending, true)
    handleHook('UserPromptSubmit', {}, deps('TechLead'))
    assert.equal(existsSync(p.pending), false)
  })

  it('スクリプトを通さない書き換えの後はボードを取り直す', () => {
    handleHook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh project item-edit --id X' } }, deps('TechLead'))
    assert.equal(refreshes, 1)
  })

  it('PreToolUse で PR への Status を拒否する', () => {
    const result = handleHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'set-status 102 作業中' } }, deps('TechLead'))
    assert.deepEqual((result.stdout as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny')
  })

  it('Stop は止めたことのない高い指摘があるときだけ一度止める', () => {
    const first = handleHook('Stop', { stop_hook_active: false }, deps('TechLead'))
    assert.equal((first.stdout as { decision?: string }).decision, 'block')
    assert.match((first.stdout as { reason: string }).reason, /app#1/)
    assert.equal(handleHook('Stop', { stop_hook_active: false }, deps('TechLead')).stdout, undefined)
  })

  it('Stop は stop_hook_active のときは止めない', () => {
    assert.equal(handleHook('Stop', { stop_hook_active: true }, deps('TechLead')).stdout, undefined)
  })

  it('isStopBlockEnabled が false なら止めない', () => {
    const off = deps('TechLead', { config: { ...config, isStopBlockEnabled: false } })
    assert.equal(handleHook('Stop', { stop_hook_active: false }, off).stdout, undefined)
  })
})

describe('部下とほかのセッション', () => {
  it('部下のフックは心拍だけを書き、何も入れない', () => {
    const busy = handleHook('PostToolUse', { tool_name: 'Read', tool_input: {} }, deps('SWE1'))
    assert.equal(busy.stdout, undefined)
    const beat = readJson<{ state: string } | null>(join(p.heartbeats, 'sid-SWE1.json'), null)
    assert.equal(beat?.state, 'busy')
    handleHook('Stop', { stop_hook_active: false }, deps('SWE1'))
    assert.equal(readJson<{ state: string } | null>(join(p.heartbeats, 'sid-SWE1.json'), null)?.state, 'idle')
  })

  it('許可の確認の通知で許可待ちにする', () => {
    handleHook('Notification', { notification_type: 'permission_prompt' }, deps('SWE1'))
    assert.equal(readJson<{ state: string } | null>(join(p.heartbeats, 'sid-SWE1.json'), null)?.state, 'waiting')
  })

  it('チームの外のセッションでは何もしない', () => {
    const result = handleHook('Stop', { stop_hook_active: false }, deps(null))
    assert.equal(result.stdout, undefined)
    assert.throws(() => readdirSync(p.heartbeats))
  })
})

describe('節目の記録の起動', () => {
  const sprint = {
    checkpoints: ['08:00', '13:00', '21:00'],
    utcOffset: '+09:00',
    pointsField: 'ストーリーポイント',
    pointBudgets: { '3': 2 },
  }
  const withSprint = (name: string | null) => deps(name, { config: { ...config, sprint } })

  it('記録していない節目があれば、部下のフックからでも裏で記録を始める', () => {
    handleHook('Stop', { stop_hook_active: false }, withSprint('SWE1'))
    assert.equal(checkpoints, 1)
  })

  it('TechLead のフックからも始める', () => {
    handleHook('UserPromptSubmit', {}, withSprint('TechLead'))
    assert.equal(checkpoints, 1)
  })

  it('チームの外のセッションと、sprint の設定が無いときは始めない', () => {
    handleHook('Stop', { stop_hook_active: false }, withSprint(null))
    handleHook('Stop', { stop_hook_active: false }, deps('SWE1'))
    assert.equal(checkpoints, 0)
  })
})
