import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAdapterModule } from '../src/adapter-module.ts'
import { callBoardProgram } from '../src/adapters/command/call.ts'
import { checkBoardModule } from '../src/adapters/module/check.ts'
import { parseConfig, type Config } from '../src/config.ts'
import { buildPorts } from '../src/wiring.ts'
import { config as base, issue, NOW } from './helpers.ts'

const FAKE = fileURLToPath(new URL('./fixtures/board-program/fake-tracker.mjs', import.meta.url))

/** A copy of the fake tracker that only the user can write (the harness refuses a program others can write). */
function program(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'scrum-board-program-')), 'fake-tracker.mjs')
  copyFileSync(FAKE, path)
  chmodSync(path, 0o755)
  return path
}

const item = (extra: Record<string, unknown> = {}) => ({ itemId: 'i1', kind: 'issue', repo: 'ENG', number: 1, title: 't', state: 'OPEN', author: null, status: 'Backlog', reason: 'None', since: null, owner: null, assignee: null, ...extra })
const snapshot = (items: readonly object[] = [item()]) => ({ items, openIssues: [] })

const specOf = (options: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const parsed = parseAdapterModule({ command: [program()], options, ...extra })
  if (parsed === null || parsed === undefined || !('command' in parsed)) throw new Error('not a command spec')
  return parsed
}
const withProgram = (options: Record<string, unknown>): Config => ({ ...base, adapters: specOf(options) })

describe('the command form of the adapters section', () => {
  it('reads a program, its capabilities, a timeout, and options, with defaults', () => {
    assert.deepEqual(parseAdapterModule({ command: ['/opt/board/tracker', '--site', 'x'] }), { command: ['/opt/board/tracker', '--site', 'x'], capabilities: [], timeoutSeconds: 30, options: {} })
    assert.deepEqual(parseAdapterModule({ command: ['/opt/board/tracker'], capabilities: ['write', 'comments', 'write'], timeoutSeconds: 60, options: { site: 'x' } }), { command: ['/opt/board/tracker'], capabilities: ['write', 'comments'], timeoutSeconds: 60, options: { site: 'x' } })
  })

  it('is null for a shape that is wrong, or that names both a module and a command, so it never falls back to GitHub', () => {
    const wrong = [{ command: [] }, { command: 'tracker' }, { command: ['relative/tracker'] }, { command: ['/x', ''] }, { command: ['/x'], capabilities: ['delete'] }, { command: ['/x'], timeoutSeconds: 0 }, { command: ['/x'], timeoutSeconds: 301 }, { command: ['/x'], timeoutSeconds: 1.5 }, { command: ['/x'], extra: 1 }, { command: ['/x'], module: '/y.mjs' }, { options: {} }]
    for (const raw of wrong) assert.equal(parseAdapterModule(raw), null, JSON.stringify(raw))
    assert.equal(parseConfig({ ...base, adapters: { command: ['x'] } }), null)
    assert.deepEqual(parseConfig({ ...base, adapters: { command: ['/x'] } })?.adapters, { command: ['/x'], capabilities: [], timeoutSeconds: 30, options: {} })
  })
})

describe('calling the tracker program', () => {
  it('sends one JSON request that names the protocol and carries the options, and returns the result', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'scrum-board-log-')), 'log')
    const spec = specOf({ log, snapshot: snapshot() })
    assert.deepEqual(callBoardProgram(spec, { op: 'snapshot', now: NOW.toISOString() }), snapshot())
    const sent = JSON.parse(readFileSync(log, 'utf8'))
    assert.deepEqual([sent.board, sent.op, sent.now, sent.options.snapshot !== undefined], ['scrum-board/1', 'snapshot', NOW.toISOString(), true])
  })

  const failures: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
    ['an error answer', { mode: 'error' }, /refused snapshot: the tracker is down/],
    ['an answer that is not JSON', { mode: 'garbage' }, /did not answer with JSON.*this is not json/],
    ['no answer at all', { mode: 'silent' }, /did not answer with JSON/],
  ]
  for (const [name, options, message] of failures) {
    it(`throws, with the program's own words, for ${name}`, () => {
      assert.throws(() => callBoardProgram(specOf(options), { op: 'snapshot' }), message)
    })
  }

  it('stops a call that takes longer than the timeout', () => {
    assert.throws(() => callBoardProgram(specOf({ mode: 'slow' }, { timeoutSeconds: 1 }), { op: 'snapshot' }), /did not answer: .*ETIMEDOUT/)
  })

  it('refuses a program that is not a file of the user, that others can write, or that is not there', () => {
    const open = program()
    chmodSync(open, 0o777)
    assert.throws(() => callBoardProgram({ ...specOf({}), command: [open] }, { op: 'snapshot' }), /written by the group or by others/)
    assert.throws(() => callBoardProgram({ ...specOf({}), command: ['/nonexistent/tracker'] }, { op: 'snapshot' }), /does not exist/)
  })

  it('never puts the request in an error message', () => {
    const secret = 'SECRET-TOKEN-in-options'
    assert.throws(() => callBoardProgram(specOf({ mode: 'garbage', token: secret }), { op: 'snapshot' }), (error: Error) => !error.message.includes(secret))
  })
})

describe('the board a program provides', () => {
  it('reads the snapshot, with the time of the read when the program gives none, and the references the program set', () => {
    const ports = buildPorts(withProgram({ snapshot: snapshot([item({ ref: 'ENG-123', number: 123 })]) }))
    const read = ports.board.fetchSnapshot(NOW)
    assert.deepEqual([read.fetchedAt, read.items.map((one) => one.ref)], [NOW.toISOString(), ['ENG-123']])
  })

  it('leaves every other port GitHub, and offers no write the program did not list', () => {
    const ports = buildPorts(withProgram({ snapshot: snapshot() }))
    assert.equal(typeof ports.code.openPullRequests, 'function')
    assert.equal(ports.writer.canAssign, buildPorts(base).writer.canAssign)
  })

  it('refuses a snapshot that does not fit the contract, naming what is wrong', () => {
    const ports = buildPorts(withProgram({ snapshot: snapshot([item({ kind: 'task', status: 'Triage' })]) }))
    assert.throws(() => ports.board.fetchSnapshot(NOW), /does not fit the contract: .*kind must be one of issue, pr, draft.*Status "Triage"/)
    assert.throws(() => buildPorts(withProgram({ snapshot: 5 })).board.fetchSnapshot(NOW), /must answer a snapshot/)
  })

  it('refuses an item whose reference cannot be judged', () => {
    const ports = buildPorts(withProgram({ snapshot: snapshot([item({ repo: 'ENG:team' })]) }))
    assert.throws(() => ports.board.fetchSnapshot(NOW), /cannot be judged|does not fit/)
  })

  it('reads the Status history of items by reference, and answers null when the program cannot say or answers wrongly', () => {
    const events = { 'ENG#1': [{ at: '2026-11-24T10:00:00Z', status: 'In Progress' }] }
    const items = [issue(1, { repo: 'ENG' })]
    assert.deepEqual([...(buildPorts(withProgram({ snapshot: snapshot(), statusEvents: events })).board.statusEvents(items) ?? [])], [['ENG#1', events['ENG#1']]])
    assert.equal(buildPorts(withProgram({ snapshot: snapshot() })).board.statusEvents(items), null)
    assert.equal(buildPorts(withProgram({ snapshot: snapshot(), statusEvents: { 'ENG#1': [{ at: 'never', status: 'x' }] } })).board.statusEvents(items), null)
    assert.equal(buildPorts(withProgram({ snapshot: snapshot(), mode: 'error' })).board.statusEvents(items), null)
  })
})

describe('scrum adapter check on a program', () => {
  it('checks the snapshot the program reads and lists every problem', () => {
    const good = checkBoardModule(specOf({ snapshot: snapshot() }), base, NOW)
    assert.equal(good.isOk, true, good.text)
    assert.match(good.text, /^program\s+.*fake-tracker\.mjs/)
    assert.match(good.text, /snapshot\s+1 items, 0 open issues, 0 problems/)
    const bad = checkBoardModule(specOf({ snapshot: snapshot([item({ repo: 'a:b' }), item({ itemId: '', kind: 'task' })]) }), base, NOW)
    assert.equal(bad.isOk, false)
    assert.match(bad.text, /does not fit/)
    assert.match(bad.text, /kind must be one of/)
  })

  it('says why a program cannot be called', () => {
    const result = checkBoardModule(specOf({ mode: 'error' }), base, NOW)
    assert.equal(result.isOk, false)
    assert.match(result.text, /snapshot\s+FAILED: .*the tracker is down/)
  })
})
