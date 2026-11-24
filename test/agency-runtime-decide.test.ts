import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSnapshot, saveSnapshot } from '../src/board/snapshot.ts'
import type { BoardItem } from '../src/board/types.ts'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import { decisionComment } from '../src/agency-runtime/decide.ts'
import type { Ports } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import { board, config } from './agency-runtime-board.ts'
import { fakePorts } from './fake-ports.ts'
import { NOW } from './helpers.ts'

let p: Paths
let comments: { repo: string; number: number; body: string }[]
let reasons: { ref: number | null; reason: string }[]
let existing: string[]

const decision = (overrides: object = {}) => ({ kind: 'judge', target: 'app#14', by: 'alice', payload: { text: 'Yes, drop it.' }, ...overrides })
const request = (value: object = decision()): string => JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'decide', decision: value })

function ports(overrides: { canSetReason?: boolean; addComment?: Ports['issues']['addComment']; setReason?: Ports['writer']['setReason'] } = {}): RuntimeDeps['ports'] {
  const base = fakePorts()
  return {
    ...base,
    issues: {
      ...base.issues,
      comments: () => existing.map((body) => ({ body, createdAt: NOW.toISOString() })),
      addComment: overrides.addComment ?? ((repo, number, body) => void comments.push({ repo, number, body })),
    },
    writer: {
      ...base.writer,
      canSetReason: overrides.canSetReason ?? true,
      setReason: overrides.setReason ?? ((item: BoardItem, reason) => void reasons.push({ ref: item.number, reason })),
    },
  }
}

const run = (input: string, deps: Partial<RuntimeDeps> = {}) => {
  const output = runRuntime(input, { p, config, now: NOW, ports: ports(), spawnRefresh: () => undefined, ...deps })
  return { exitCode: output.exitCode, response: JSON.parse(output.stdout) as { result?: unknown; error?: { status: number; message: string } } }
}

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-runtime-decide-')))
  comments = []
  reasons = []
  existing = []
  saveSnapshot(p, board())
})

describe('agency-runtime/1 decide', () => {
  it('records the decision on the issue, clears the block, and answers with an empty result', () => {
    const { exitCode, response } = run(request())
    assert.deepEqual([exitCode, response], [0, { result: {} }])
    assert.deepEqual(comments, [{ repo: 'example-org/app', number: 14, body: decisionComment(decision() as never) }])
    assert.deepEqual(reasons, [{ ref: 14, reason: config.reasonNone }])
  })

  it('keeps the board copy in step, so the request is gone from the next view', () => {
    run(request())
    const item = loadSnapshot(p)?.items.find((one) => one.number === 14)
    assert.deepEqual([item?.reason, item?.since], [config.reasonNone, null])
  })

  it('writes the text and the choice into the comment, behind a machine-readable first line', () => {
    const body = decisionComment({ kind: 'judge', target: 'app#14', by: 'alice', payload: { text: 'Go ahead.', choice: 'approve' } })
    assert.equal(body.split('\n')[0], '<!-- agency-runtime:decision by=alice -->')
    assert.deepEqual(body.split('\n').slice(1), ['Decision by alice.', 'Choice: approve', '', 'Go ahead.'])
  })

  it('does not post the same decision twice when it is applied again after a half failure', () => {
    existing = [decisionComment(decision() as never)]
    const { exitCode } = run(request())
    assert.equal(exitCode, 0)
    assert.deepEqual(comments, [])
    assert.equal(reasons.length, 1)
  })

  it('does not clear the block when the comment could not be posted, and says to retry (503)', () => {
    const failing = ports({
      addComment: () => {
        throw new Error('gh failed')
      },
    })
    const { exitCode, response } = run(request(), { ports: failing })
    assert.equal(exitCode, 1)
    assert.equal(response.error?.status, 503)
    assert.deepEqual(reasons, [])
    assert.equal(loadSnapshot(p)?.items.find((one) => one.number === 14)?.reason, config.reasonJudge)
  })

  it('answers 503 when the block cannot be cleared because no script is configured', () => {
    const { response } = run(request(), { ports: ports({ canSetReason: false }) })
    assert.equal(response.error?.status, 503)
    assert.match(response.error?.message ?? '', /setReason/)
    assert.deepEqual(comments, [])
  })

  it('refuses an unknown target and an item that is not waiting for a decision (404)', () => {
    assert.equal(run(request(decision({ target: 'app#999' }))).response.error?.status, 404)
    assert.equal(run(request(decision({ target: 'app#12' }))).response.error?.status, 404)
    assert.deepEqual(comments, [])
  })

  it('refuses an answer to a request, since this harness raises none (404)', () => {
    assert.equal(run(request(decision({ kind: 'answer', target: 'r-1' }))).response.error?.status, 404)
  })

  it('does not let an answer clear a pending decision by naming its ref (404)', () => {
    assert.equal(run(request(decision({ kind: 'answer', target: 'app#14' }))).response.error?.status, 404)
    assert.deepEqual([comments, reasons], [[], []])
  })

  it('refuses an empty decision (400)', () => {
    assert.equal(run(request(decision({ payload: { text: '  ' } }))).response.error?.status, 400)
  })

  const malformed: readonly (readonly [string, object])[] = [
    ['an unknown kind', decision({ kind: 'veto' })],
    ['a missing target', decision({ target: '' })],
    ['a decider that is not an id', decision({ by: 'Alice Smith' })],
    ['a payload without text', decision({ payload: {} })],
    ['a choice that is not text', decision({ payload: { text: 'x', choice: 1 } })],
    ['text that is too long', decision({ payload: { text: 'x'.repeat(70_000) } })],
  ]
  for (const [name, value] of malformed) {
    it(`refuses ${name} (400) without touching the board`, () => {
      assert.equal(run(request(value)).response.error?.status, 400)
      assert.deepEqual([comments, reasons], [[], []])
    })
  }

  it('answers 503 while there is no board', () => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-runtime-decide-empty-')))
    assert.equal(run(request()).response.error?.status, 503)
  })
})
