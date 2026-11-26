import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeTranscripts } from '../src/adapters/compose-transcripts.ts'
import { parseRolloutLine, scanRollout } from '../src/adapters/codex/rollout-lines.ts'
import { codexTranscripts } from '../src/adapters/codex/transcripts.ts'
import type { TranscriptFile } from '../src/ports/index.ts'
import { costOf, priceOf } from '../src/usage/pricing.ts'
import { EMPTY_INDEX, updateIndex } from '../src/usage/index-store.ts'
import { membersBySession } from '../src/usage/attribution.ts'
import { summarize } from '../src/usage/summary.ts'
import { assistantLine, fileOf, sourceOf, writeTranscript, SESSION_A } from './usage-fixtures.ts'

const CODEX_SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const OTHER_SESSION = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const dir = () => mkdtempSync(join(tmpdir(), 'scrum-codex-usage-'))

type Usage = { input: number; cached: number; output: number; reasoning?: number; write?: number }
const meta = (cwd = '/work/team'): string => JSON.stringify({ timestamp: '2026-11-26T03:00:00.000Z', type: 'session_meta', payload: { id: CODEX_SESSION, cwd } })
const turn = (model: string): string => JSON.stringify({ timestamp: '2026-11-26T03:00:01.000Z', type: 'turn_context', payload: { model, effort: 'medium' } })
function tokenCount(at: string, last: Usage, total: number): string {
  const usage = (u: Usage) => ({ input_tokens: u.input, cached_input_tokens: u.cached, cache_write_input_tokens: u.write ?? 0, output_tokens: u.output, reasoning_output_tokens: u.reasoning ?? 0, total_tokens: u.input + u.output })
  return JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage(last), total_token_usage: { total_tokens: total } } } })
}
const FIRST = tokenCount('2026-11-26T03:00:05.000Z', { input: 13321, cached: 11008, output: 131, reasoning: 10 }, 13452)
const SECOND = tokenCount('2026-11-26T03:00:07.000Z', { input: 13501, cached: 13056, output: 15 }, 26968)

describe('reading a Codex session record', () => {
  it('counts a response: the uncached input, the cached input as a cache read, and the output with its reasoning', () => {
    const { row } = parseRolloutLine(FIRST, CODEX_SESSION)
    assert.deepEqual(row?.tokens, { input: 2313, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 11008, output: 131 })
    assert.equal(row?.requestId, `${CODEX_SESSION}:13452`)
    assert.equal(row?.at, Date.parse('2026-11-26T03:00:05.000Z'))
  })

  it('reads the model of a turn and the directory of the session, and nothing from any other line', () => {
    assert.deepEqual(parseRolloutLine(turn('gpt-x'), CODEX_SESSION), { model: 'gpt-x' })
    assert.deepEqual(parseRolloutLine(meta('/work/a'), CODEX_SESSION), { cwd: '/work/a' })
    assert.deepEqual(parseRolloutLine(JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'token_count turn_context' } }), CODEX_SESSION), {})
    assert.deepEqual(parseRolloutLine('not json token_count', CODEX_SESSION), {})
    assert.deepEqual(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }), CODEX_SESSION), {})
  })

  it('treats a count that is not a whole non-negative number as 0, and never lets the cached part pass the input', () => {
    const odd = JSON.stringify({ timestamp: '2026-11-26T03:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 99, output_tokens: -5 }, total_token_usage: { total_tokens: 5 } } } })
    assert.deepEqual(parseRolloutLine(odd, CODEX_SESSION).row?.tokens, { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 10, output: 0 })
  })
})

describe('scanning a Codex session file', () => {
  const file = (lines: readonly string[], complete = true): string => {
    const path = join(dir(), `rollout-2026-11-26T03-00-00-${CODEX_SESSION}.jsonl`)
    writeTranscript(path, lines, complete)
    return path
  }

  it('gives each response once, with the model of its turn', () => {
    const path = file([meta(), turn('gpt-x'), FIRST, FIRST, turn('gpt-y'), SECOND])
    const scan = scanRollout(path, CODEX_SESSION, 0)
    assert.deepEqual(scan.rows.map((row) => [row.requestId.split(':')[1], row.model]), [['13452', 'gpt-x'], ['26968', 'gpt-y']])
  })

  it('leaves out a response before any model is known, since it cannot be priced or attributed', () => {
    assert.equal(scanRollout(file([meta(), FIRST]), CODEX_SESSION, 0).rows.length, 0)
  })

  it('reads on from where it ended, with the model of the turn it is in, and leaves a line that is still being written', () => {
    const path = file([meta(), turn('gpt-x'), FIRST])
    const first = scanRollout(path, CODEX_SESSION, 0)
    appendFileSync(path, `${SECOND}\n${FIRST.slice(0, 20)}`)
    const next = scanRollout(path, CODEX_SESSION, first.endOffset, new Set(first.rows.map((row) => row.requestId)))
    assert.deepEqual(next.rows.map((row) => [row.requestId.split(':')[1], row.model]), [['26968', 'gpt-x']])
    assert.ok(next.endOffset < Buffer.byteLength(`${meta()}\n${turn('gpt-x')}\n${FIRST}\n${SECOND}\n${FIRST.slice(0, 20)}`))
  })

  it('has no messages or titles: nothing but token use leaves the record', () => {
    const scan = scanRollout(file([meta(), turn('gpt-x'), FIRST]), CODEX_SESSION, 0)
    assert.deepEqual([scan.messages, scan.titles], [[], []])
  })
})

describe('the Codex sessions on disk', () => {
  function home(): string {
    const root = dir()
    const day = join(root, 'sessions', '2026', '11', '26')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, `rollout-2026-11-26T03-00-00-${CODEX_SESSION}.jsonl`), [meta('/work/team'), turn('gpt-x'), FIRST].join('\n') + '\n')
    writeFileSync(join(day, `rollout-2026-11-26T04-00-00-${OTHER_SESSION}.jsonl`), [JSON.stringify({ type: 'session_meta', payload: { cwd: '/private/other' } }), turn('gpt-x'), SECOND].join('\n') + '\n')
    writeFileSync(join(day, 'notes.txt'), 'not a rollout')
    writeFileSync(join(day, 'rollout-broken.jsonl'), '')
    return root
  }

  it('lists the rollout files by session id, grouped by the directory the session ran in', () => {
    const files = codexTranscripts(home()).files()
    assert.deepEqual(files.map((one) => [one.sessionId, one.project, one.isSubagent]).toSorted(), [[CODEX_SESSION, '/work/team', false], [OTHER_SESSION, '/private/other', false]])
    assert.equal(files.every((one) => one.size > 0), true)
  })

  it('has nothing when there are no sessions', () => {
    assert.deepEqual(codexTranscripts(dir()).files(), [])
  })

  it('counts a Codex member\'s tokens under its name, at 0 dollars, next to a Claude member\'s', () => {
    const codex = codexTranscripts(home())
    const claudeDir = dir()
    const claudePath = join(claudeDir, `${SESSION_A}.jsonl`)
    writeTranscript(claudePath, [assistantLine({ at: '2026-11-26T02:00:00.000Z', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 500 } })])
    const claude = sourceOf([fileOf(claudePath, SESSION_A, 1000, 'claude-project')])
    const both = composeTranscripts([claude, codex])
    const files = both.files()
    const index = updateIndex(join(dir(), 'index.json'), files.map((one) => (one.path === claudePath ? { ...one, size: Buffer.byteLength(`${assistantLine({ at: '2026-11-26T02:00:00.000Z', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 500 } })}\n`) } : one)), both, new Date('2026-11-26T12:00:00Z'))
    const names = new Map([[SESSION_A, 'TechLead'], [CODEX_SESSION, 'CodexA']])
    const summary = summarize({ index, memberOf: membersBySession(index, names, new Set(['TechLead', 'CodexA'])), days: 2, now: new Date('2026-11-26T12:00:00Z'), offsetMinutes: 0 })
    const codexPerson = summary.byPerson.find((one) => one.person === 'CodexA')
    assert.deepEqual([codexPerson?.tokens, codexPerson?.costUsd], [{ input: 2313, output: 131, cacheRead: 11008, cacheWrite: 0 }, 0])
    assert.equal((summary.byPerson.find((one) => one.person === 'TechLead')?.costUsd ?? 0) > 0, true)
    assert.equal(summary.byPerson.some((one) => one.person === 'Someone'), false)
  })
})

describe('the sources together', () => {
  it('scans each file by the source that listed it, and offers every source\'s names', () => {
    const a = sourceOf([], new Map([['s1', 'One']]))
    const b: ReturnType<typeof sourceOf> = { files: () => [{ path: '/x/y.jsonl', sessionId: 's2', project: 'p', isSubagent: false, size: 1 } as TranscriptFile], names: () => new Map([['s2', 'Two']]), scan: () => ({ rows: [], messages: [], titles: ['from b'], endOffset: 7 }) }
    const both = composeTranscripts([a, b])
    assert.deepEqual([...both.names()].toSorted(), [['s1', 'One'], ['s2', 'Two']])
    const [file] = both.files()
    assert.equal(both.scan(file as TranscriptFile, 0, new Set()).endOffset, 7)
    assert.throws(() => both.scan({ path: '/unknown', sessionId: 's', project: 'p', isSubagent: false, size: 0 }, 0, new Set()), /no transcript source lists/)
  })
})

describe('what a model costs', () => {
  it('is 0 for a model that is not a Claude model, since no price of another product is listed, and unchanged for Claude', () => {
    const tokens = { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1_000_000 }
    assert.equal(costOf('gpt-x', tokens, false), 0)
    assert.equal(costOf('claude-opus-5-5', tokens, false), 24)
    assert.deepEqual(priceOf('claude-unknown-model'), priceOf('claude-opus-5-5'))
  })
})
