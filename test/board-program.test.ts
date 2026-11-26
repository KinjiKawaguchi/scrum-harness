import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
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

  it('leaves the code host GitHub, and replaces the writer and the issue thread so that nothing is written to GitHub', () => {
    const ports = buildPorts(withProgram({ snapshot: snapshot() }))
    assert.equal(typeof ports.code.openPullRequests, 'function')
    assert.equal(buildPorts(base).writer.canAssign, true)
    assert.equal(ports.writer.canAssign, false)
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

describe('what a program can write, by its capabilities', () => {
  const logFile = () => join(mkdtempSync(join(tmpdir(), 'scrum-board-log-')), 'log')
  const requests = (log: string): readonly Record<string, unknown>[] => readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
  const portsWith = (capabilities: readonly string[], options: Record<string, unknown> = {}) => {
    const log = logFile()
    const cfg: Config = { ...base, adapters: specOf({ log, snapshot: snapshot(), ...options }, { capabilities }) }
    return { ports: buildPorts(cfg), log }
  }
  const target = issue(1, { repo: 'ENG', ref: 'ENG-1', itemId: 'i1' })

  it('writes the assignee, Status, blocked reason, and overrun with `write`, naming the item by its reference', () => {
    const { ports, log } = portsWith(['write'])
    assert.deepEqual([ports.writer.canAssign, ports.writer.canSetReason], [true, true])
    ports.writer.assign(target, 'SWE1')
    ports.writer.setStatus(target, 'In Progress')
    ports.writer.setReason(target, 'External wait')
    assert.deepEqual(ports.writer.writeOverrun([{ itemId: 'i1', label: 'ENG-1', value: 2 }, { itemId: 'i2', label: 'ENG-2', value: null }]), [])
    assert.deepEqual(requests(log).map((one) => [one.op, (one.item as { ref: string }).ref, one.field, one.value]), [['set', 'ENG-1', 'assignee', 'SWE1'], ['set', 'ENG-1', 'status', 'In Progress'], ['set', 'ENG-1', 'reason', 'External wait'], ['set', 'ENG-1', 'overrun', 2], ['set', 'ENG-2', 'overrun', null]])
  })

  it('names the item\'s ids too, so a program can find it by its own id', () => {
    const { ports, log } = portsWith(['write'])
    ports.writer.setStatus(target, 'Done')
    assert.deepEqual(requests(log)[0]?.item, { ref: 'ENG-1', itemId: 'i1', repo: 'ENG', number: 1 })
  })

  it('refuses every write without `write`, and never falls back to the GitHub writer (which has scripts here)', () => {
    const { ports, log } = portsWith([])
    assert.equal(buildPorts(base).writer.canAssign, true)
    assert.deepEqual([ports.writer.canAssign, ports.writer.canSetReason], [false, false])
    assert.throws(() => ports.writer.assign(target, 'SWE1'), /assigning is not available: .*"write"/)
    assert.throws(() => ports.writer.setStatus(target, 'Done'), /setting a Status is not available/)
    assert.throws(() => ports.writer.setReason(target, 'x'), /setting a blocked reason is not available/)
    assert.equal(ports.writer.writeOverrun([]).length, 0)
    assert.match(ports.writer.writeOverrun([{ itemId: 'i1', label: 'ENG-1', value: 1 }])[0] ?? '', /not available/)
    assert.equal(existsSync(log), false)
  })

  it('offers `add` and `team` only when they are listed', () => {
    assert.deepEqual([portsWith(['write']).ports.writer.addToBoard, portsWith(['write']).ports.writer.setTeam], [undefined, undefined])
    const { ports, log } = portsWith(['add', 'team'])
    ports.writer.addToBoard?.('ENG', 7)
    ports.writer.setTeam?.(target, 'clients')
    assert.deepEqual(requests(log).map((one) => [one.op, one.repo, one.number, one.field, one.value]), [['add', 'ENG', 7, undefined, undefined], ['set', undefined, undefined, 'team', 'clients']])
  })

  it('reports the overrun marks the program refused, one by one, and goes on', () => {
    const { ports } = portsWith(['write'], { failOps: ['set'] })
    const failures = ports.writer.writeOverrun([{ itemId: 'i1', label: 'ENG-1', value: 1 }, { itemId: 'i2', label: 'ENG-2', value: 2 }])
    assert.deepEqual(failures.map((one) => one.slice(0, 6)), ['ENG-1:', 'ENG-2:'])
    assert.match(failures[0] ?? '', /set failed/)
  })

  it('reads and adds comments with `comments`, and has none without it (never the GitHub thread)', () => {
    const comments = [{ body: 'First', createdAt: '2026-11-24T10:00:00Z', url: 'https://tracker.example/1' }]
    const { ports, log } = portsWith(['comments'], { comments })
    assert.deepEqual(ports.issues.comments(target), comments)
    ports.issues.addComment(target, 'A decision')
    assert.deepEqual(requests(log).map((one) => [one.op, one.body]), [['comments', undefined], ['comment', 'A decision']])
    const none = portsWith([]).ports
    assert.deepEqual(none.issues.comments(target), [])
    assert.throws(() => none.issues.addComment(target, 'x'), /commenting is not available/)
    assert.equal(none.issues.openIssues, undefined)
  })

  it('refuses comments that do not have the shape of the contract', () => {
    assert.throws(() => portsWith(['comments'], { comments: [{ body: 1 }] }).ports.issues.comments(target), /list of \{ body, createdAt, url\? \}/)
  })
})

describe('a decision on a pending item through a program', () => {
  it('posts the decision as a comment, then clears the block, and refuses without the capabilities', async () => {
    const { runRuntime } = await import('../src/agency-runtime/handle.ts')
    const { saveSnapshot } = await import('../src/board/snapshot.ts')
    const { paths } = await import('../src/store.ts')
    const run = (capabilities: readonly string[]) => {
      const log = join(mkdtempSync(join(tmpdir(), 'scrum-board-log-')), 'log')
      const cfg: Config = { ...base, adapters: specOf({ log, snapshot: snapshot() }, { capabilities }) }
      const p = paths(mkdtempSync(join(tmpdir(), 'scrum-decide-program-')))
      saveSnapshot(p, { fetchedAt: NOW.toISOString(), items: [issue(14, { repo: 'ENG', ref: 'ENG-14', itemId: 'i14', reason: cfg.reasonJudge, since: '2026-11-20', status: 'Next' })], openIssues: [] })
      const input = JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'decide', decision: { kind: 'judge', target: 'ENG-14', by: 'alice', byParticipant: 'owner', payload: { text: 'Go ahead.' } } })
      const output = runRuntime(input, { p, config: cfg, now: NOW, ports: buildPorts(cfg), spawnRefresh: () => undefined, spawnUsageIndex: () => undefined })
      return { response: JSON.parse(output.stdout) as { result?: unknown; error?: { status: number; message: string } }, log }
    }
    const both = run(['write', 'comments'])
    assert.deepEqual(both.response, { result: {} })
    assert.deepEqual(readFileSync(both.log, 'utf8').split('\n').filter((l) => l !== '').map((l) => (JSON.parse(l) as { op: string }).op), ['comments', 'comment', 'set'])
    assert.equal(run(['comments']).response.error?.status, 503)
    assert.equal(run(['write']).response.error?.status, 503)
  })
})
