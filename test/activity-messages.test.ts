import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanFile } from '../src/adapters/claude-code/transcript-lines.ts'
import { readEvents } from '../src/activity/log.ts'
import { messageEvents } from '../src/activity/messages.ts'
import { paths, type Paths } from '../src/store.ts'
import { runUsageIndex } from '../src/usage/run.ts'
import { config } from './agency-runtime-board.ts'
import { NOW } from './helpers.ts'
import { appendTranscript, assistantLine, BODY, fileOf, SESSION_A, SESSION_B, SESSION_OTHER, sendMessageLine, sourceOf, writeTranscript } from './usage-fixtures.ts'

const sizeOf = (path: string): number => statSync(path).size
const dir = () => mkdtempSync(join(tmpdir(), 'scrum-activity-messages-'))
const scanOf = (lines: readonly string[]) => {
  const path = join(dir(), 'session.jsonl')
  writeTranscript(path, lines)
  return scanFile(path, 0)
}

describe('reading the messages a session sent', () => {
  it('takes the recipient, the sender\'s own summary, the call\'s id, and the line\'s time', () => {
    const { messages } = scanOf([sendMessageLine()])
    assert.deepEqual(messages, [{ toolUseId: 'toolu_1', at: Date.parse('2026-11-24T10:00:00.000Z'), to: 'SWE1', summary: 'Asks for a review' }])
  })

  it('never takes the body: it is not in anything the scan returns', () => {
    const scan = scanOf([sendMessageLine(), assistantLine()])
    assert.equal(JSON.stringify(scan).includes(BODY), false)
  })

  it('collapses white space in the summary, cuts it at 120 characters, and gives an empty one when there is none', () => {
    const long = `${'word '.repeat(60)}end`
    const { messages } = scanOf([sendMessageLine({ id: 'a', input: { to: 'SWE1', summary: '  Two\n lines  ' } }), sendMessageLine({ id: 'b', input: { to: 'SWE1', summary: long } }), sendMessageLine({ id: 'c', input: { to: 'SWE1' } })])
    assert.deepEqual(messages.map((one) => one.summary.length > 0 ? one.summary.length : 0), [9, 120, 0])
    assert.equal(messages[0]?.summary, 'Two lines')
    assert.equal(messages[2]?.summary, '')
  })

  it('takes `recipient` when there is no `to`, and skips a call with no recipient or no id', () => {
    const { messages } = scanOf([sendMessageLine({ id: 'a', input: { to: undefined, recipient: 'AgencyLead' } }), sendMessageLine({ id: 'b', input: { to: '' } }), sendMessageLine({ id: '', input: { to: 'SWE1' } })])
    assert.deepEqual(messages.map((one) => one.to), ['AgencyLead'])
  })

  it('reads each call once, and only from assistant lines', () => {
    const user = JSON.stringify({ type: 'user', message: { content: `"name":"SendMessage" to SWE9 ${BODY}` } })
    const { messages } = scanOf([sendMessageLine({ id: 'a' }), sendMessageLine({ id: 'a' }), user])
    assert.equal(messages.length, 1)
  })

  it('reads several calls in one line', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-11-24T10:00:00.000Z', message: { content: ['text', { type: 'tool_use', id: 'x1', name: 'SendMessage', input: { to: 'A', summary: 's1' } }, { type: 'tool_use', id: 'x2', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'x3', name: 'SendMessage', input: { to: 'B' } }] } })
    assert.deepEqual(scanOf([line]).messages.map((one) => one.to), ['A', 'B'])
  })
})

describe('the message events', () => {
  const message = (to: string) => ({ toolUseId: `t-${to}`, at: Date.parse('2026-11-24T10:00:00.000Z'), to, summary: 's' })

  it('names the sender, the recipient, the time, and the summary, with a stable id', () => {
    const [event] = messageEvents('session-1', 'TechLead', [message('SWE1')])
    assert.deepEqual([event?.kind, event?.from, event?.to, event?.at, event?.summary], ['message', 'TechLead', 'SWE1', '2026-11-24T10:00:00.000Z', 's'])
    assert.equal(event?.id, messageEvents('session-1', 'TechLead', [message('SWE1')])[0]?.id)
    assert.notEqual(event?.id, messageEvents('session-2', 'TechLead', [message('SWE1')])[0]?.id)
  })

  it('leaves out a recipient that is not a plain name, and a message to the sender itself', () => {
    assert.deepEqual(messageEvents('s', 'TechLead', [message('uds:/tmp/cc-socks/1.sock'), message('../x'), message(''), message('TechLead'), message('AgencyLead')]).map((one) => one.to), ['AgencyLead'])
  })
})

describe('the transcript reader writes the messages of the team to the activity log', () => {
  let p: Paths
  let team: string
  const now = new Date('2026-11-24T10:30:00.000Z')
  beforeEach(() => {
    p = paths(dir())
    mkdirSync(join(p.dir, 'cache'), { recursive: true })
    team = dir()
  })

  const run = (names: ReadonlyMap<string, string>, files: ReturnType<typeof fileOf>[]) => runUsageIndex(p, config, sourceOf(files, names), now)
  const names = new Map([[SESSION_A, 'TechLead'], [SESSION_B, 'SWE1'], [SESSION_OTHER, 'Someone Else']])

  it('keeps what a team session sent, from its name, and nothing of a session outside the team or of a subagent', () => {
    const a = join(team, `${SESSION_A}.jsonl`)
    const other = join(team, `${SESSION_OTHER}.jsonl`)
    const sub = join(team, 'sub.jsonl')
    writeTranscript(a, [assistantLine(), sendMessageLine({ id: 'a1' })])
    writeTranscript(other, [sendMessageLine({ id: 'o1' })])
    writeTranscript(sub, [sendMessageLine({ id: 's1' })])
    run(names, [fileOf(a, SESSION_A, sizeOf(a)), fileOf(other, SESSION_OTHER, sizeOf(other)), { ...fileOf(sub, SESSION_A, sizeOf(sub)), isSubagent: true }])
    const events = readEvents(p.activityLog)
    assert.deepEqual(events.map((one) => (one.kind === 'message' ? [one.from, one.to, one.summary] : [])), [['TechLead', 'SWE1', 'Asks for a review']])
  })

  it('does not copy the body into the log, and does not repeat an event when a transcript is read again', () => {
    const a = join(team, `${SESSION_A}.jsonl`)
    writeTranscript(a, [sendMessageLine({ id: 'a1' })])
    run(names, [fileOf(a, SESSION_A, sizeOf(a))])
    appendTranscript(a, [sendMessageLine({ id: 'a2', at: '2026-11-24T10:10:00.000Z' })])
    run(names, [fileOf(a, SESSION_A, sizeOf(a))])
    assert.deepEqual(readEvents(p.activityLog).map((one) => one.at), ['2026-11-24T10:00:00.000Z', '2026-11-24T10:10:00.000Z'])
    assert.equal(readFileSync(p.activityLog, 'utf8').includes(BODY), false)
  })

  it('leaves out a message older than the 24 hours the log keeps', () => {
    const a = join(team, `${SESSION_A}.jsonl`)
    writeTranscript(a, [sendMessageLine({ id: 'old', at: '2026-11-22T10:00:00.000Z' }), sendMessageLine({ id: 'new' })])
    run(names, [fileOf(a, SESSION_A, sizeOf(a))])
    assert.equal(readEvents(p.activityLog).length, 1)
  })

  it('counts a second session that took a name as the same member ("SWE1 (2)")', () => {
    const b = join(team, `${SESSION_B}.jsonl`)
    writeTranscript(b, [sendMessageLine({ id: 'b1', input: { to: 'TechLead', summary: 'Done' } })])
    run(new Map([[SESSION_B, 'SWE1 (2)']]), [fileOf(b, SESSION_B, sizeOf(b))])
    assert.deepEqual(readEvents(p.activityLog).map((one) => (one.kind === 'message' ? one.from : '')), ['SWE1'])
  })
})
