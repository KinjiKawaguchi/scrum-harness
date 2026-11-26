import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeSessions } from '../src/adapters/claude-code/sessions.ts'
import { claudeCodeTurnError, claudeCodeVersion } from '../src/adapters/claude-code/turn-error.ts'
import { lintAll } from '../src/findings/lint.ts'
import { findTurnErrors, lintTurnErrors, type MemberTurnError } from '../src/members/api-errors.ts'
import { formatReport, memberReport, runningVersions } from '../src/members/list.ts'
import type { SessionDirectory, TurnError } from '../src/ports/index.ts'
import type { SessionSignal } from '../src/team/types.ts'
import { config as base, NOW } from './helpers.ts'

const SESSION = 'sess-0001-aaaa'
const user = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-11-26T06:00:00Z', version: '2.1.258', ...extra })
const reply = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: '2026-11-26T06:01:00Z', version: '2.1.258', ...extra })
const failure = (error = 'invalid_request', text = 'Prompt is too long\nrun /compact') => reply(text, { isApiErrorMessage: true, error, timestamp: '2026-11-26T06:56:45Z' })

function transcript(records: readonly unknown[], raw = ''): readonly string[] {
  const root = mkdtempSync(join(tmpdir(), 'scrum-turn-error-'))
  mkdirSync(join(root, 'project-a'))
  writeFileSync(join(root, 'project-a', `${SESSION}.jsonl`), `${raw}${records.map((one) => JSON.stringify(one)).join('\n')}\n`)
  return [root]
}

describe('the API error that ended a session\'s last turn (from its transcript)', () => {
  it('reads an error that is the last thing in the record: its kind, the first line of its text, when, and that nothing came after it', () => {
    assert.deepEqual(claudeCodeTurnError(transcript([user('go'), reply('ok'), failure()]), SESSION), { error: 'invalid_request', text: 'Prompt is too long', at: '2026-11-26T06:56:45Z', count: 1, isLast: true })
  })

  it('counts errors in a row, whatever the person wrote between them, and a reply that is not an error breaks the run', () => {
    assert.equal(claudeCodeTurnError(transcript([failure(), user('again'), failure()]), SESSION)?.count, 2)
    assert.equal(claudeCodeTurnError(transcript([failure(), user('again'), reply('fine'), user('more'), failure()]), SESSION)?.count, 1)
  })

  it('says the error is not the last thing when the person wrote after it', () => {
    const error = claudeCodeTurnError(transcript([reply('ok'), failure(), user('try again')]), SESSION)
    assert.deepEqual([error?.count, error?.isLast], [1, false])
  })

  it('is no error when the last reply is a normal one, for a sub-agent\'s records, an unknown session, a bad id, or a transcript that is not JSON', () => {
    assert.equal(claudeCodeTurnError(transcript([failure(), reply('recovered')]), SESSION), null)
    assert.equal(claudeCodeTurnError(transcript([reply('ok'), { ...failure(), isSidechain: true }]), SESSION), null)
    assert.equal(claudeCodeTurnError(transcript([failure()]), 'sess-9999-zzzz'), null)
    assert.equal(claudeCodeTurnError(transcript([failure()]), '../../etc/passwd'), null)
    assert.equal(claudeCodeTurnError(transcript([], 'not json\n'), SESSION), null)
    assert.equal(claudeCodeTurnError(['/no/such/folder'], SESSION), null)
  })

  it('reads only the end of a large transcript, and drops the fragment of a line that the read starts in', () => {
    const filler = Array.from({ length: 4000 }, (_, index) => user(`message ${index} ${'x'.repeat(60)}`))
    assert.equal(claudeCodeTurnError(transcript([...filler, failure('rate_limit', 'Limit reached')]), SESSION)?.error, 'rate_limit')
  })

  it('reads the Claude Code version that wrote the latest records', () => {
    assert.equal(claudeCodeVersion(transcript([user('go', { version: '2.1.200' }), reply('ok', { version: '2.1.258' })]), SESSION), '2.1.258')
    assert.equal(claudeCodeVersion(transcript([reply('ok', { version: 'x y' })]), SESSION), null)
    assert.equal(claudeCodeVersion(['/no/such/folder'], SESSION), null)
  })

  it('is offered by the Claude Code session directory', () => {
    const sessions = claudeCodeSessions([], transcript([reply('ok'), failure()]))
    assert.equal(sessions.turnError?.(SESSION)?.error, 'invalid_request')
    assert.equal(sessions.version?.(SESSION), '2.1.258')
  })
})

describe('members stuck on an API error', () => {
  const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()
  const signal = (name: string, state: SessionSignal['state'], minutes: number, extra: Partial<SessionSignal> = {}): SessionSignal => ({ sessionId: `sess-${name}-0001`, name, state, since: ago(minutes), updatedAt: ago(minutes), isAlive: true, nameSince: null, ...extra })
  const error = (extra: Partial<TurnError> = {}): TurnError => ({ error: 'invalid_request', text: 'Prompt is too long', at: '2026-11-26T06:56:45Z', count: 1, isLast: true, ...extra })
  const sessionsOf = (errors: Record<string, TurnError | null>): SessionDirectory => ({ find: () => ({ name: null, pid: null }), signals: () => [], turnError: (id) => errors[id] ?? null })

  it('reports an idle member after 3 minutes when the error is the last thing in its record', () => {
    const found = (minutes: number, turn: TurnError) => findTurnErrors([signal('SWE1', 'idle', minutes)], sessionsOf({ 'sess-SWE1-0001': turn }), ['SWE1'], NOW)
    assert.deepEqual(found(4, error()).map((one) => one.name), ['SWE1'])
    assert.deepEqual(found(2, error()), [])
    assert.deepEqual(found(10, error({ isLast: false })), [])
  })

  it('reports a busy member only when the error came twice in a row, and never one that waits at a prompt', () => {
    const found = (state: SessionSignal['state'], turn: TurnError) => findTurnErrors([signal('SWE1', state, 10)], sessionsOf({ 'sess-SWE1-0001': turn }), ['SWE1'], NOW)
    assert.deepEqual(found('busy', error({ count: 1, isLast: false })), [])
    assert.deepEqual(found('busy', error({ count: 2, isLast: false })).map((one) => one.count), [2])
    assert.deepEqual(found('waiting', error({ count: 3 })), [])
  })

  it('ignores a member without a live session, and a session directory that cannot tell', () => {
    assert.deepEqual(findTurnErrors([signal('SWE1', 'idle', 10, { isAlive: false })], sessionsOf({ 'sess-SWE1-0001': error() }), ['SWE1'], NOW), [])
    assert.deepEqual(findTurnErrors([signal('SWE1', 'idle', 10)], { find: () => ({ name: null, pid: null }), signals: () => [] }, ['SWE1'], NOW), [])
  })

  it('is M-API-ERROR (high) naming the error and its text, with the way out, raised again for a newer error', () => {
    const [one] = lintTurnErrors([{ ...error({ count: 2, isLast: false }), name: 'SWE1' }])
    assert.deepEqual([one?.rule, one?.severity, one?.subject], ['M-API-ERROR', 'high', 'SWE1'])
    assert.match(one?.message ?? '', /SWE1 looks busy, but its last reply was an API error \(invalid_request, 2 in a row\): Prompt is too long/)
    assert.match(one?.fix ?? '', /\/compact.*member stop SWE1.*member start SWE1 --resume/)
    assert.notEqual(one?.key, lintTurnErrors([{ ...error({ at: '2026-11-26T09:00:00Z' }), name: 'SWE1' }])[0]?.key)
    assert.equal(lintTurnErrors([]).length, 0)
  })

  it('replaces the idle finding of that member, and leaves the others', () => {
    const idle = ['SWE1', 'SWE2'].map((name) => ({ name, state: 'idle' as const, since: ago(120) }))
    const context = { snapshot: { fetchedAt: NOW.toISOString(), items: [], openIssues: [] }, members: idle, acks: [], config: base, now: NOW } as unknown as Parameters<typeof lintAll>[0]
    const stuck: readonly MemberTurnError[] = [{ ...error(), name: 'SWE1' }]
    const rules = lintAll({ ...context, turnErrors: stuck }).active.map((finding) => `${finding.rule}:${finding.subject}`)
    assert.ok(rules.includes('M-API-ERROR:SWE1'))
    assert.ok(!rules.includes('T-IDLE:SWE1'))
    assert.ok(rules.includes('T-IDLE:SWE2'))
  })

  it('shows the Claude Code version of each running member in the member list', () => {
    const live = [signal('SWE1', 'idle', 1)]
    const report = memberReport({ ...base, members: ['SWE1', 'SWE2'] }, ['SWE1'], live)
    const sessions: SessionDirectory = { find: () => ({ name: null, pid: null }), signals: () => live, version: (id) => (id === 'sess-SWE1-0001' ? '2.1.258' : null) }
    const text = formatReport(report, [], runningVersions(report, live, sessions))
    assert.match(text, /SWE1 .*running \(idle\) \[claude 2\.1\.258\]/)
    assert.doesNotMatch(text, /SWE2.*claude/)
    assert.doesNotMatch(formatReport(report), /claude 2/)
  })
})
