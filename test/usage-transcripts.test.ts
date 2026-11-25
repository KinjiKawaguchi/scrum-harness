import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRow, parseLine, scanFile } from '../src/adapters/claude-code/transcript-lines.ts'
import { recordedNames, transcriptsIn } from '../src/adapters/claude-code/transcripts.ts'
import { EMPTY_INDEX, scanInto, updateIndex } from '../src/usage/index-store.ts'
import { appendTranscript, assistantLine, fileOf, SESSION_A, SESSION_B, sourceOf, titleLine, writeTranscript } from './usage-fixtures.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'scrum-usage-'))

describe('reading a transcript line', () => {
  it('reads the tokens of a response, splitting the cache writes by lifetime', () => {
    const line = assistantLine({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 9, cache_creation: { ephemeral_1h_input_tokens: 4, ephemeral_5m_input_tokens: 5 } } })
    assert.deepEqual(parseLine(line).row?.tokens, { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 5, cacheWrite1h: 4 })
  })

  it('counts all cache writes as 5-minute writes when the lifetimes are not given', () => {
    const line = assistantLine({ usage: { cache_creation_input_tokens: 7 } })
    assert.deepEqual([parseLine(line).row?.tokens.cacheWrite5m, parseLine(line).row?.tokens.cacheWrite1h], [7, 0])
  })

  it('treats a count that is not a whole non-negative number as 0 and drops the fraction', () => {
    const row = parseLine(assistantLine({ usage: { input_tokens: -5, output_tokens: 'many', cache_read_input_tokens: 2.9 } })).row
    assert.deepEqual([row?.tokens.input, row?.tokens.output, row?.tokens.cacheRead], [0, 0, 2])
  })

  it('marks fast mode', () => {
    assert.equal(parseLine(assistantLine({ speed: 'fast' })).row?.isFast, true)
    assert.equal(parseLine(assistantLine()).row?.isFast, false)
  })

  it('reads the time and the model', () => {
    const row = parseLine(assistantLine({ at: '2026-11-24T10:00:00.000Z', model: 'claude-sonnet-5-5' })).row
    assert.deepEqual([row?.at, row?.model], [Date.parse('2026-11-24T10:00:00.000Z'), 'claude-sonnet-5-5'])
  })

  const dropped: readonly (readonly [string, string])[] = [
    ['a synthetic model', assistantLine({ model: '<synthetic>' })],
    ['a line without a request id', JSON.stringify({ type: 'assistant', timestamp: '2026-11-24T10:00:00.000Z', message: { model: 'm', usage: { input_tokens: 1 } } })],
    ['a line without usage', JSON.stringify({ type: 'assistant', requestId: 'r', timestamp: '2026-11-24T10:00:00.000Z', message: { model: 'm' } })],
    ['a line with an unreadable time', assistantLine({ at: 'yesterday' })],
    ['a line that is not JSON', '{"type":"assistant" oops'],
    ['a user line', JSON.stringify({ type: 'user', message: { content: '"type":"assistant"' } })],
  ]
  for (const [name, line] of dropped) {
    it(`drops ${name}`, () => {
      assert.equal(parseLine(line).row, undefined)
    })
  }

  it('reads the name a session recorded for itself', () => {
    assert.equal(parseLine(titleLine('SWE1')).title, 'SWE1')
    assert.equal(parseLine(JSON.stringify({ type: 'agent-name', agentName: 'SWE2' })).title, 'SWE2')
  })

  it('takes the larger value of each field when two lines belong to one response', () => {
    const early = parseLine(assistantLine({ usage: { input_tokens: 5, output_tokens: 1 } })).row
    const late = parseLine(assistantLine({ usage: { input_tokens: 5, output_tokens: 9 } })).row
    assert.ok(early !== undefined && late !== undefined)
    assert.equal(mergeRow(early, late).tokens.output, 9)
    assert.equal(mergeRow(late, early).tokens.output, 9)
  })
})

describe('scanning a transcript file', () => {
  it('counts a response once even though its lines repeat the usage', () => {
    const path = join(dir(), 'a.jsonl')
    writeTranscript(path, [assistantLine({ usage: { input_tokens: 5, output_tokens: 3 } }), assistantLine({ usage: { input_tokens: 5, output_tokens: 8 } }), assistantLine({ requestId: 'req_2' })])
    const scan = scanFile(path, 0)
    assert.equal(scan.rows.length, 2)
    assert.equal(scan.rows.find((row) => row.requestId === 'req_1')?.tokens.output, 8)
  })

  it('stops at the last newline and leaves a line that is still being written for the next scan', () => {
    const path = join(dir(), 'a.jsonl')
    const first = assistantLine({ requestId: 'req_1' })
    writeTranscript(path, [first, assistantLine({ requestId: 'req_2' }).slice(0, 30)], true)
    const scan = scanFile(path, 0)
    assert.deepEqual(scan.rows.map((row) => row.requestId), ['req_1'])
    assert.equal(scan.endOffset, Buffer.byteLength(first) + 1 + Buffer.byteLength(assistantLine({ requestId: 'req_2' }).slice(0, 30)) + 1)
  })

  it('does not read past a line without a newline', () => {
    const path = join(dir(), 'a.jsonl')
    writeFileSync(path, `${assistantLine({ requestId: 'req_1' })}\n${assistantLine({ requestId: 'req_2' })}`)
    const scan = scanFile(path, 0)
    assert.deepEqual(scan.rows.map((row) => row.requestId), ['req_1'])
    assert.equal(scan.endOffset, Buffer.byteLength(assistantLine({ requestId: 'req_1' })) + 1)
  })

  it('leaves out the responses it is told to skip', () => {
    const path = join(dir(), 'a.jsonl')
    writeTranscript(path, [assistantLine({ requestId: 'req_1' }), assistantLine({ requestId: 'req_2' })])
    assert.deepEqual(scanFile(path, 0, new Set(['req_1'])).rows.map((row) => row.requestId), ['req_2'])
  })

  it('reads multi-byte text without losing the position', () => {
    const path = join(dir(), 'a.jsonl')
    writeTranscript(path, [JSON.stringify({ type: 'user', text: 'こんにちは' }), assistantLine({ requestId: 'req_1' })])
    assert.equal(scanFile(path, 0).endOffset, statSync(path).size)
  })
})

describe('the index of transcripts', () => {
  const setup = () => {
    const root = dir()
    const path = join(root, `${SESSION_A}.jsonl`)
    return { root, path, indexPath: join(root, 'index.json') }
  }
  const sizeOf = (path: string) => statSync(path).size

  it('reads only what a file gained since the last run', () => {
    const { path } = setup()
    writeTranscript(path, [assistantLine({ requestId: 'req_1', usage: { input_tokens: 1 } })])
    const first = scanInto(EMPTY_INDEX, fileOf(path, SESSION_A, sizeOf(path)), sourceOf([]))
    appendTranscript(path, [assistantLine({ requestId: 'req_2', at: '2026-11-24T11:00:00.000Z', usage: { input_tokens: 2 } })])
    const second = scanInto(first, fileOf(path, SESSION_A, sizeOf(path)), sourceOf([]))
    assert.deepEqual(second.rows.map((row) => row[4]), [1, 2])
  })

  it('does not count a response twice when the previous run ended inside it', () => {
    const { path } = setup()
    writeTranscript(path, [assistantLine({ requestId: 'req_1', usage: { input_tokens: 4 } })])
    const first = scanInto(EMPTY_INDEX, fileOf(path, SESSION_A, sizeOf(path)), sourceOf([]))
    appendTranscript(path, [assistantLine({ requestId: 'req_1', usage: { input_tokens: 4, output_tokens: 6 } })])
    const second = scanInto(first, fileOf(path, SESSION_A, sizeOf(path)), sourceOf([]))
    assert.equal(second.rows.length, 1)
  })

  it('does nothing for a file that has not grown', () => {
    const { path } = setup()
    writeTranscript(path, [assistantLine()])
    const file = fileOf(path, SESSION_A, sizeOf(path))
    const first = scanInto(EMPTY_INDEX, file, sourceOf([]))
    assert.equal(scanInto(first, file, sourceOf([])), first)
  })

  it('keeps the earlier rows and reads only what follows when a file was rewritten shorter', () => {
    const { path } = setup()
    writeTranscript(path, [assistantLine({ requestId: 'req_1' }), assistantLine({ requestId: 'req_2' })])
    const first = scanInto(EMPTY_INDEX, fileOf(path, SESSION_A, sizeOf(path)), sourceOf([]))
    writeTranscript(path, [assistantLine({ requestId: 'req_1' })])
    const second = scanInto(first, fileOf(path, SESSION_A, sizeOf(path)), sourceOf([]))
    assert.equal(second.rows.length, first.rows.length)
    assert.equal(second.files[path]?.offset, sizeOf(path))
  })

  it('sums the responses of one minute, model, and speed into one row', () => {
    const { path } = setup()
    writeTranscript(path, [
      assistantLine({ requestId: 'req_1', at: '2026-11-24T10:00:05.000Z', usage: { input_tokens: 1 } }),
      assistantLine({ requestId: 'req_2', at: '2026-11-24T10:00:40.000Z', usage: { input_tokens: 2 } }),
      assistantLine({ requestId: 'req_3', at: '2026-11-24T10:00:50.000Z', usage: { input_tokens: 4 }, speed: 'fast' }),
    ])
    const index = scanInto(EMPTY_INDEX, fileOf(path, SESSION_A, sizeOf(path)), sourceOf([]))
    assert.deepEqual(index.rows.map((row) => [row[3], row[4]]).toSorted(), [[0, 3], [1, 4]])
  })

  it('remembers the title of a session, but not the title of a subagent', () => {
    const { root } = setup()
    const main = join(root, 'main.jsonl')
    const sub = join(root, 'sub.jsonl')
    writeTranscript(main, [titleLine('SWE1')])
    writeTranscript(sub, [titleLine('Explore')])
    const index = [fileOf(main, SESSION_A, sizeOf(main)), fileOf(sub, SESSION_B, sizeOf(sub), 'proj', true)].reduce((acc, file) => scanInto(acc, file, sourceOf([])), EMPTY_INDEX)
    assert.deepEqual(index.titles, { [SESSION_A]: 'SWE1' })
  })

  it('saves the index and picks up where it left off in the next run', () => {
    const { path, indexPath } = setup()
    writeTranscript(path, [assistantLine({ requestId: 'req_1' })])
    const files = () => [fileOf(path, SESSION_A, sizeOf(path))]
    const now = new Date('2026-11-24T12:00:00.000Z')
    assert.equal(updateIndex(indexPath, files(), sourceOf([]), now).rows.length, 1)
    appendTranscript(path, [assistantLine({ requestId: 'req_2', at: '2026-11-24T11:00:00.000Z' })])
    const again = updateIndex(indexPath, files(), sourceOf([]), now)
    assert.deepEqual([again.rows.length, again.updatedAt], [2, now.toISOString()])
  })
})

describe('the Claude Code transcript layout', () => {
  it('lists the session transcripts and the subagent transcripts under them, and ignores other files', () => {
    const project = join(dir(), 'proj')
    writeTranscript(join(project, `${SESSION_A}.jsonl`), [assistantLine()])
    writeTranscript(join(project, SESSION_A, 'subagents', 'agent-1.jsonl'), [assistantLine()])
    writeFileSync(join(project, 'notes.jsonl'), '')
    const files = transcriptsIn(project)
    assert.deepEqual(files.map((file) => [file.sessionId, file.isSubagent]), [[SESSION_A, false], [SESSION_A, true]])
    assert.ok(files.every((file) => file.project === project))
  })

  it('returns nothing for a folder that does not exist', () => {
    assert.deepEqual(transcriptsIn(join(dir(), 'missing')), [])
  })

  it('maps a session id to a name from the session records and from the title file, the session record winning', () => {
    const root = dir()
    mkdirSync(join(root, 'proj', SESSION_A), { recursive: true })
    writeFileSync(join(root, 'proj', SESSION_A, 'custom-title.json'), JSON.stringify({ customTitle: 'from-title' }))
    mkdirSync(join(root, 'proj', SESSION_B), { recursive: true })
    writeFileSync(join(root, 'proj', SESSION_B, 'custom-title.json'), JSON.stringify({ customTitle: 'old-title' }))
    const names = recordedNames([{ sessionId: SESSION_B, name: 'SWE2' }, { sessionId: 7, name: 'bad' }, { name: 'no id' }], root)
    assert.deepEqual([...names].toSorted(), [[SESSION_A, 'from-title'], [SESSION_B, 'SWE2']])
  })
})
