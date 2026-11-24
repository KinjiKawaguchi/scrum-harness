import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeNodes } from '../src/board/snapshot.ts'
import { nextHeartbeat } from '../src/team/heartbeat.ts'
import { findSessionName } from '../src/team/identity.ts'
import { paths, readJson, tryLock, writeJson } from '../src/store.ts'

describe('normalizeNodes', () => {
  const page = JSON.parse(readFileSync(new URL('./fixtures/graphql-page.json', import.meta.url), 'utf8'))
  const items = normalizeNodes(page.data.node.items.nodes)

  it('issue の項目と内容を平らにする', () => {
    assert.deepEqual(items[0], {
      itemId: items[0]?.itemId,
      kind: 'issue',
      repo: 'example-org/app',
      number: 101,
      title: items[0]?.title,
      state: 'OPEN',
      author: 'owner',
      status: '作業中',
      reason: '前の作業待ち',
      since: '2026-10-01',
      owner: null,
      tanto: 'SWE4',
      points: null,
      overrun: null,
    })
  })

  it('PR と下書きの種類を見分ける', () => {
    assert.deepEqual(items.map((item) => item.kind), ['issue', 'pr', 'issue', 'draft'])
    assert.equal(items[1]?.status, '作業中')
    assert.equal(items[3]?.number, null)
  })

  it('値の無い項目は null にする', () => {
    assert.deepEqual([items[2]?.reason, items[2]?.tanto], [null, null])
  })
})

describe('nextHeartbeat', () => {
  const base = { sessionId: 's', name: 'SWE1', state: 'busy' as const, since: '2026-10-08T05:00:00.000Z', updatedAt: '2026-10-08T05:00:00.000Z', isAlive: true, nameSince: null }
  const at = (iso: string) => new Date(iso)

  it('状態が変わると since を今にする', () => {
    const next = nextHeartbeat(base, 's', 'SWE1', 'idle', at('2026-10-08T05:10:00.000Z'))
    assert.equal(next?.since, '2026-10-08T05:10:00.000Z')
  })

  it('同じ状態なら since を保ち、30秒以内の作業中は書かない', () => {
    assert.equal(nextHeartbeat(base, 's', 'SWE1', 'busy', at('2026-10-08T05:00:20.000Z')), null)
    const later = nextHeartbeat(base, 's', 'SWE1', 'busy', at('2026-10-08T05:01:00.000Z'))
    assert.deepEqual([later?.since, later?.updatedAt], ['2026-10-08T05:00:00.000Z', '2026-10-08T05:01:00.000Z'])
  })

  it('初めての心拍は今を since にする', () => {
    const first = nextHeartbeat(null, 's', 'SWE1', 'idle', at('2026-10-08T05:00:00.000Z'))
    assert.equal(first?.since, '2026-10-08T05:00:00.000Z')
  })
})

describe('findSessionName', () => {
  const records = [
    { pid: 1, sessionId: 'aaa', name: 'SWE1' },
    { pid: 2, sessionId: 'bbb' },
  ]

  it('session_id からセッションの名前を引く', () => {
    assert.equal(findSessionName(records, 'aaa'), 'SWE1')
  })

  it('名前が無いか見つからなければ null', () => {
    assert.equal(findSessionName(records, 'bbb'), null)
    assert.equal(findSessionName(records, 'zzz'), null)
  })
})

describe('store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-store-'))

  it('JSON を書いて読み戻す', () => {
    writeJson(join(dir, 'a', 'b.json'), { x: 1 })
    assert.deepEqual(readJson(join(dir, 'a', 'b.json'), null), { x: 1 })
  })

  it('読めないときは既定値を返す', () => {
    assert.deepEqual(readJson(join(dir, 'missing.json'), []), [])
  })

  it('生きているプロセスの錠は取れず、死んだプロセスの錠は取り直せる', () => {
    const lock = join(dir, 'watch.lock')
    writeFileSync(lock, String(process.ppid))
    assert.equal(tryLock(lock), false)
    writeFileSync(lock, '999999')
    assert.equal(tryLock(lock), true)
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid))
  })
})

describe('resolveIdentity', () => {
  it('session_id から名前と pid を引き、チームの内外を控えに書く', async () => {
    const { resolveIdentity } = await import('../src/team/identity.ts')
    const { config } = await import('./helpers.ts')
    const sessions = mkdtempSync(join(tmpdir(), 'scrum-sessions-'))
    writeFileSync(join(sessions, '10.json'), JSON.stringify({ pid: 10, sessionId: 'lead', name: 'TechLead' }))
    writeFileSync(join(sessions, '11.json'), JSON.stringify({ pid: 11, sessionId: 'other', name: 'dev-22' }))
    process.env.SCRUM_SESSIONS_DIR = sessions
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-identity-')))
    const now = new Date('2026-10-08T06:00:00.000Z')
    assert.deepEqual(resolveIdentity(p, 'lead', now, config), { sessionId: 'lead', name: 'TechLead', pid: 10 })
    resolveIdentity(p, 'other', now, config)
    assert.equal(readJson<{ role?: string } | null>(join(p.identity, 'other.json'), null)?.role, 'none')
    assert.equal(readJson<{ role?: string } | null>(join(p.identity, 'lead.json'), null)?.role, 'techlead')
  })
})

describe('logError', async () => {
  const { logError } = await import('../src/store.ts')

  it('gh の失敗は、問い合わせの文ではなく、終了コードと stderr を残す', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-log-')))
    const error = Object.assign(new Error(`Command failed: gh api graphql -f query=${'x'.repeat(2000)}`), {
      status: 1,
      stderr: 'gh: Something went wrong while executing your query.\n',
    })
    logError(p, 'refresh', error)
    const line = readFileSync(p.errors, 'utf8')
    assert.match(line, /refresh: gh が exit 1: gh: Something went wrong while executing your query\./)
    assert.doesNotMatch(line, /xxxx/)
  })

  it('ほかのエラーは文をそのまま残す', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-log-')))
    logError(p, 'watch', new Error('こわれた'))
    assert.match(readFileSync(p.errors, 'utf8'), /watch: こわれた/)
  })
})
