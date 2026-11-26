import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBoardModule } from '../src/adapters/module/check.ts'
import { snapshotProblems } from '../src/board/snapshot-check.ts'
import type { Snapshot } from '../src/board/types.ts'
import { config as base, issue, NOW } from './helpers.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'scrum-adapter-check-'))

function writeModule(source: string): string {
  const path = join(tmp(), 'module.mjs')
  writeFileSync(path, source)
  chmodSync(path, 0o644)
  return path
}

const item = (extra = '') => `{ itemId: "i1", kind: "issue", repo: "ENG", number: 1, title: "t", state: "OPEN", author: null, status: "Backlog", reason: "None", since: null, owner: null, assignee: null ${extra}}`
const MODULE = (items: string, actions = `actionsOf: (call) => call.tool === 'mcp__t__set' ? [{ kind: 'set-status', label: call.input.key, status: call.input.status }] : [], shellPatterns: () => ({ post: 'mcp__t__', pre: 'mcp__t__set' })`) => `
export const portsVersion = 1
export const createPorts = () => ({
  board: { fetchSnapshot: (now) => ({ fetchedAt: now.toISOString(), items: [${items}], openIssues: [] }), statusEvents: () => null },
  actions: { ${actions} },
})
`

describe('the problems of a snapshot', () => {
  const good = (): Snapshot => ({ fetchedAt: NOW.toISOString(), items: [issue(1), issue(2)], openIssues: [] })

  it('finds none in a good one', () => {
    assert.deepEqual(snapshotProblems(good(), base), [])
  })

  it('names what is wrong with an item, in the words of the contract', () => {
    const bad = { ...good(), items: [issue(1, { status: 'Triage', since: '10/07', kind: 'task' as never, itemId: '' }), issue(2, { repo: 'a:b' })] }
    const problems = snapshotProblems(bad, base).join('\n')
    assert.match(problems, /itemId must be non-empty text/)
    assert.match(problems, /kind must be one of issue, pr, draft/)
    assert.match(problems, /since must be YYYY-MM-DD/)
    assert.match(problems, /Status "Triage" is not one the configuration names/)
    assert.match(problems, /the reference "a:b#2" does not fit/)
  })

  it('finds two items with one reference, a wrong time, and a list that is not one', () => {
    assert.match(snapshotProblems({ ...good(), items: [issue(1), issue(1, { itemId: 'other' })] }, base).join('\n'), /the reference app#1 names 2 items/)
    assert.match(snapshotProblems({ ...good(), fetchedAt: 'yesterday' }, base).join('\n'), /fetchedAt must be an ISO 8601 time/)
    assert.match(snapshotProblems({ fetchedAt: NOW.toISOString(), items: 'x', openIssues: [] } as never, base).join('\n'), /items must be a list/)
  })

  it('reports at most the limit', () => {
    const many = { ...good(), items: Array.from({ length: 30 }, (_, index) => issue(index + 1, { status: 'Nope' })) }
    assert.equal(snapshotProblems(many, base).length, 20)
  })
})

describe('scrum adapter check', () => {
  const spec = (path: string) => ({ module: path, options: {} })

  it('loads the module, reads its snapshot, and says what it did not check', () => {
    const result = checkBoardModule(spec(writeModule(MODULE(item()))), base, NOW)
    assert.equal(result.isOk, true, result.text)
    assert.match(result.text, /load\s+ok/)
    assert.match(result.text, /ports\s+board, actions \(the rest is GitHub\)/)
    assert.match(result.text, /snapshot\s+1 items, 0 open issues, 0 problems/)
    assert.match(result.text, /patterns\s+post "mcp__t__", pre "mcp__t__set"/)
    assert.match(result.text, /not checked\s+the writes/)
  })

  it('lists every problem of the snapshot, not only the first (the loader stops at the first at a read)', () => {
    const result = checkBoardModule(spec(writeModule(MODULE(`${item()}, ${item('').replace('"ENG"', '"a:b"').replace('i1', 'i2').replace('number: 1', 'number: 2')}`))), base, NOW)
    assert.equal(result.isOk, false)
    assert.match(result.text, /snapshot\s+2 items, 0 open issues, 1 problems/)
    assert.match(result.text, /the reference "a:b#2" does not fit/)
    assert.match(result.text, /result\s+1 problem/)
  })

  it('shows what the action reader makes of tool calls from a file, and what differs from the expected commands', () => {
    const calls = join(tmp(), 'calls.json')
    writeFileSync(calls, JSON.stringify([
      { call: { tool: 'mcp__t__set', input: { key: 'ENG-1', status: 'Done' } }, expect: [{ kind: 'set-status', label: 'ENG-1', status: 'Done' }] },
      { call: { tool: 'mcp__t__set', input: { key: 'ENG-1', status: 'Done' } }, expect: [{ kind: 'set-status', label: 'ENG-1', status: 'Next' }] },
      { call: { tool: 'mcp__t__search', input: {} }, expect: [] },
    ]))
    const result = checkBoardModule(spec(writeModule(MODULE(item()))), base, NOW, calls)
    assert.match(result.text, /calls\s+2 of 3 as expected/)
    assert.match(result.text, /DIFF #2 mcp__t__set/)
    assert.equal(result.isOk, false)
  })

  it('refuses a calls file of the wrong shape, and a module that cannot be loaded, naming why', () => {
    const calls = join(tmp(), 'calls.json')
    writeFileSync(calls, '{"call": 1}')
    assert.match(checkBoardModule(spec(writeModule(MODULE(item()))), base, NOW, calls).text, /must be a list of/)
    assert.match(checkBoardModule(spec('/nonexistent/module.mjs'), base, NOW).text, /load\s+FAILED: the board module does not exist/)
  })

  it('reports a pattern that is not valid and a snapshot read that throws', () => {
    const badPattern = checkBoardModule(spec(writeModule(MODULE(item(), "actionsOf: () => [], shellPatterns: () => ({ post: '(', pre: '' })"))), base, NOW)
    assert.match(badPattern.text, /not a valid pattern/)
    const throwing = checkBoardModule(spec(writeModule(`export const portsVersion = 1\nexport const createPorts = () => ({ board: { fetchSnapshot: () => { throw new Error('no token') }, statusEvents: () => null } })`)), base, NOW)
    assert.match(throwing.text, /snapshot\s+FAILED: no token/)
  })
})

describe('the command', () => {
  it('prints the result and exits 0 for a good module, 1 for a bad one, and the usage without a module', () => {
    const state = tmp()
    mkdirSync(join(state, 'log'), { recursive: true })
    const run = (module: string | null, args: readonly string[]) => {
      writeFileSync(join(state, 'config.json'), JSON.stringify({ ...base, ...(module === null ? {} : { adapters: { module } }) }))
      return spawnSync(process.execPath, ['--no-warnings', CLI, 'adapter', 'check', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SCRUM_STATE_DIR: state, HOME: state } })
    }
    const good = run(writeModule(MODULE(item())), [])
    assert.deepEqual([good.status, /result\s+ok/.test(good.stdout)], [0, true])
    const bad = run('/nonexistent/module.mjs', [])
    assert.deepEqual([bad.status, /load\s+FAILED/.test(bad.stdout)], [1, true])
    const none = run(null, [])
    assert.deepEqual([none.status, /Usage: scrum adapter check/.test(none.stderr)], [1, true])
    assert.equal(run(null, ['--module', writeModule(MODULE(item()))]).status, 0)
  })
})
