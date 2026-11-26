import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeNodes } from '../src/adapters/github/item-node.ts'
import { nextHeartbeat } from '../src/team/heartbeat.ts'
import { claudeCodeSessions, findSessionName } from '../src/adapters/claude-code/sessions.ts'
import { paths, readJson, tryLock, writeJson } from '../src/store.ts'

describe('normalizeNodes', () => {
  const page = JSON.parse(readFileSync(new URL('./fixtures/graphql-page.json', import.meta.url), 'utf8'))
  const items = normalizeNodes(page.data.node.items.nodes)

  it('flattens the items and content of an issue', () => {
    assert.deepEqual(items[0], {
      itemId: items[0]?.itemId,
      kind: 'issue',
      repo: 'example-org/app',
      number: 101,
      title: items[0]?.title,
      state: 'OPEN',
      author: 'owner',
      status: 'In Progress',
      reason: 'Waiting on earlier work',
      since: '2026-10-01',
      owner: null,
      assignee: 'SWE4',
      points: null,
      overrun: null,
    })
  })

  it('tells PRs and drafts apart', () => {
    assert.deepEqual(items.map((item) => item.kind), ['issue', 'pr', 'issue', 'draft'])
    assert.equal(items[1]?.status, 'In Progress')
    assert.equal(items[3]?.number, null)
  })

  it('turns items without a value into null', () => {
    assert.deepEqual([items[2]?.reason, items[2]?.assignee], [null, null])
  })
})

describe('nextHeartbeat', () => {
  const base = { sessionId: 's', name: 'SWE1', state: 'busy' as const, since: '2026-10-08T05:00:00.000Z', updatedAt: '2026-10-08T05:00:00.000Z', isAlive: true, nameSince: null }
  const at = (iso: string) => new Date(iso)

  it('when the state changes, sets since to now', () => {
    const next = nextHeartbeat(base, 's', 'SWE1', 'idle', at('2026-10-08T05:10:00.000Z'))
    assert.equal(next?.since, '2026-10-08T05:10:00.000Z')
  })

  it('when the state is the same, keeps since; does not write In Progress within 30 seconds', () => {
    assert.equal(nextHeartbeat(base, 's', 'SWE1', 'busy', at('2026-10-08T05:00:20.000Z')), null)
    const later = nextHeartbeat(base, 's', 'SWE1', 'busy', at('2026-10-08T05:01:00.000Z'))
    assert.deepEqual([later?.since, later?.updatedAt], ['2026-10-08T05:00:00.000Z', '2026-10-08T05:01:00.000Z'])
  })

  it('the first heartbeat sets since to now', () => {
    const first = nextHeartbeat(null, 's', 'SWE1', 'idle', at('2026-10-08T05:00:00.000Z'))
    assert.equal(first?.since, '2026-10-08T05:00:00.000Z')
  })
})

describe('findSessionName', () => {
  const records = [
    { pid: 1, sessionId: 'aaa', name: 'SWE1' },
    { pid: 2, sessionId: 'bbb' },
  ]

  it('looks up the session name from session_id', () => {
    assert.equal(findSessionName(records, 'aaa'), 'SWE1')
  })

  it('null when there is no name or it is not found', () => {
    assert.equal(findSessionName(records, 'bbb'), null)
    assert.equal(findSessionName(records, 'zzz'), null)
  })
})

describe('store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-store-'))

  it('writes JSON and reads it back', () => {
    writeJson(join(dir, 'a', 'b.json'), { x: 1 })
    assert.deepEqual(readJson(join(dir, 'a', 'b.json'), null), { x: 1 })
  })

  it('returns the default when it cannot be read', () => {
    assert.deepEqual(readJson(join(dir, 'missing.json'), []), [])
  })

  it('cannot take the lock of a live process, and can retake the lock of a dead process', () => {
    const lock = join(dir, 'watch.lock')
    writeFileSync(lock, String(process.ppid))
    assert.equal(tryLock(lock), false)
    writeFileSync(lock, '999999')
    assert.equal(tryLock(lock), true)
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid))
  })
})

describe('resolveIdentity', () => {
  it('looks up the name and pid from session_id and writes whether the session is inside or outside the team into the copy', async () => {
    const { resolveIdentity } = await import('../src/team/identity.ts')
    const { config } = await import('./helpers.ts')
    const sessions = mkdtempSync(join(tmpdir(), 'scrum-sessions-'))
    writeFileSync(join(sessions, '10.json'), JSON.stringify({ pid: 10, sessionId: 'lead', name: 'TechLead' }))
    writeFileSync(join(sessions, '11.json'), JSON.stringify({ pid: 11, sessionId: 'other', name: 'dev-22' }))
    process.env.SCRUM_SESSIONS_DIR = sessions
    // A member's own session sets its name in the environment, which wins over the session record; the test is about the record.
    delete process.env.SCRUM_NAME
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-identity-')))
    const now = new Date('2026-10-08T06:00:00.000Z')
    assert.deepEqual(resolveIdentity(p, 'lead', now, config, claudeCodeSessions()), { sessionId: 'lead', name: 'TechLead', pid: 10 })
    resolveIdentity(p, 'other', now, config, claudeCodeSessions())
    assert.equal(readJson<{ role?: string } | null>(join(p.identity, 'other.json'), null)?.role, 'none')
    assert.equal(readJson<{ role?: string } | null>(join(p.identity, 'lead.json'), null)?.role, 'techlead')
  })
})

describe('resolveIdentity for a session whose name is in the environment', () => {
  it('keeps the name in the identity record, so the token use of a session with no other record of its name is attributed', async () => {
    const { resolveIdentity } = await import('../src/team/identity.ts')
    const { identityNames } = await import('../src/usage/attribution.ts')
    const { config } = await import('./helpers.ts')
    const before = process.env.SCRUM_NAME
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-identity-')))
    try {
      process.env.SCRUM_NAME = 'SWE1'
      const first = new Date('2026-10-08T06:00:00.000Z')
      assert.deepEqual(resolveIdentity(p, 'codex-session', first, config, claudeCodeSessions()), { sessionId: 'codex-session', name: 'SWE1', pid: null })
      assert.deepEqual([...identityNames(p)], [['codex-session', 'SWE1']])
      assert.equal(readJson<{ role?: string } | null>(join(p.identity, 'codex-session.json'), null)?.role, 'member')
      // the calls after leave the record as it is
      resolveIdentity(p, 'codex-session', new Date('2026-10-08T07:00:00.000Z'), config, claudeCodeSessions())
      assert.equal(readJson<{ checkedAt?: string } | null>(join(p.identity, 'codex-session.json'), null)?.checkedAt, first.toISOString())
      // a different name replaces it
      process.env.SCRUM_NAME = 'SWE2'
      resolveIdentity(p, 'codex-session', new Date('2026-10-08T08:00:00.000Z'), config, claudeCodeSessions())
      assert.deepEqual([...identityNames(p)], [['codex-session', 'SWE2']])
    } finally {
      if (before === undefined) delete process.env.SCRUM_NAME
      else process.env.SCRUM_NAME = before
    }
  })
})

describe('logError', async () => {
  const { logError } = await import('../src/store.ts')

  it('for a gh failure, keeps the exit code and stderr, not the query text', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-log-')))
    const error = Object.assign(new Error(`Command failed: gh api graphql -f query=${'x'.repeat(2000)}`), {
      status: 1,
      stderr: 'gh: Something went wrong while executing your query.\n',
    })
    logError(p, 'refresh', error)
    const line = readFileSync(p.errors, 'utf8')
    assert.match(line, /refresh: gh exited with 1: gh: Something went wrong while executing your query\./)
    assert.doesNotMatch(line, /xxxx/)
  })

  it('keeps the message as is for other errors', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-log-')))
    logError(p, 'watch', new Error('broke'))
    assert.match(readFileSync(p.errors, 'utf8'), /watch: broke/)
  })
})
