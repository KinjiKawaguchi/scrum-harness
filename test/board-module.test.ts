import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAdapterModule } from '../src/adapter-module.ts'
import { checkModulePorts } from '../src/adapters/module/load.ts'
import { isItemRef, itemRefProblems } from '../src/board/item-ref.ts'
import { parseConfig, type Config } from '../src/config.ts'
import { buildPorts } from '../src/wiring.ts'
import { config as base, issue, NOW } from './helpers.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'scrum-board-module-'))

/** Writes a module file (ES modules) and returns its path. */
function writeModule(source: string, mode = 0o644): string {
  const path = join(tmp(), 'module.mjs')
  writeFileSync(path, source)
  chmodSync(path, mode)
  return path
}

const withModule = (path: string, options: Record<string, unknown> = {}): Config => ({ ...base, adapters: { module: path, options } })

/** A module that provides only a board, whose one item carries what the module was given, so a test can see it. */
const BOARD_MODULE = (item = '{ itemId: "x", kind: "issue", repo: "ENG", number: 123, title: JSON.stringify(options), state: "OPEN", author: null, status: "Backlog", reason: "None", since: null, owner: null, assignee: null }') => `
export const portsVersion = 1
export function createPorts(config, options) {
  return { board: { fetchSnapshot: (now) => ({ fetchedAt: now.toISOString(), items: [${item}], openIssues: [] }), statusEvents: () => null } }
}
`

describe('the adapters section', () => {
  it('reads a module path and its options, and is absent when not given', () => {
    assert.equal(parseAdapterModule(undefined), undefined)
    assert.deepEqual(parseAdapterModule({ module: '/opt/board/module.mjs' }), { module: '/opt/board/module.mjs', options: {} })
    assert.deepEqual(parseAdapterModule({ module: '~/board.mjs', options: { project: 'ENG' } }), { module: '~/board.mjs', options: { project: 'ENG' } })
  })

  it('is null for a section of the wrong shape, so it never falls back to the GitHub adapters', () => {
    for (const raw of [null, 'x', [], {}, { module: 'relative/module.mjs' }, { module: '/x.mjs', options: [] }, { module: '/x.mjs', extra: 1 }, { module: 7 }]) {
      assert.equal(parseAdapterModule(raw), null, JSON.stringify(raw))
    }
    assert.equal(parseConfig({ ...base, adapters: { module: 'relative.mjs' } }), null)
    assert.equal(parseConfig({ ...base, adapters: { module: '/x.mjs' } })?.adapters?.module, '/x.mjs')
  })
})

describe('loading a board module', () => {
  it('replaces the board with the module\'s, passes the options, and leaves the other ports GitHub', () => {
    const ports = buildPorts(withModule(writeModule(BOARD_MODULE()), { project: 'ENG' }))
    const snapshot = ports.board.fetchSnapshot(NOW)
    assert.deepEqual(snapshot.items.map((item) => [item.repo, item.number, item.title]), [['ENG', 123, '{"project":"ENG"}']])
    assert.equal(buildPorts(base).board === ports.board, false)
    assert.equal(typeof ports.writer.setStatus, 'function')
    assert.equal(typeof ports.issues.addComment, 'function')
  })

  it('gives the module a copy of the configuration, so it cannot change the harness\'s', () => {
    const config = withModule(writeModule(`
export const portsVersion = 1
export default (config) => { config.techlead = 'changed'; config.members.push('x'); return {} }
`))
    buildPorts(config)
    assert.deepEqual([config.techlead, config.members], [base.techlead, base.members])
  })

  it('loads a module through a link to a file the user owns', () => {
    const real = writeModule(BOARD_MODULE())
    const link = join(tmp(), 'link.mjs')
    symlinkSync(real, link)
    assert.equal(buildPorts(withModule(link)).board.fetchSnapshot(NOW).items.length, 1)
  })

  const refused: readonly (readonly [string, () => Config, RegExp])[] = [
    ['a file that is not there', () => withModule('/nonexistent/module.mjs'), /does not exist/],
    ['a directory', () => withModule(tmp()), /not a regular file/],
    ['a file the group can write', () => withModule(writeModule(BOARD_MODULE(), 0o664)), /written by the group or by others \(mode 664\)/],
    ['a file others can write', () => withModule(writeModule(BOARD_MODULE(), 0o646)), /written by the group or by others/],
    ['a module with no portsVersion', () => withModule(writeModule('export const createPorts = () => ({})')), /must export portsVersion = 1/],
    ['a module of another portsVersion', () => withModule(writeModule('export const portsVersion = 2\nexport const createPorts = () => ({})')), /must export portsVersion = 1 \(it exports 2\)/],
    ['a module with no createPorts', () => withModule(writeModule('export const portsVersion = 1')), /must export a function createPorts/],
    ['a module that does not load', () => withModule(writeModule('export const portsVersion = 1\nthrow new Error("boom")')), /could not be loaded: boom/],
    ['a module whose createPorts does not return an object', () => withModule(writeModule('export const portsVersion = 1\nexport const createPorts = () => 5')), /must return an object of ports/],
    ['a port that does not exist (a typo)', () => withModule(writeModule('export const portsVersion = 1\nexport const createPorts = () => ({ bord: {} })')), /ports that do not exist: bord/],
    ['a board without its functions', () => withModule(writeModule('export const portsVersion = 1\nexport const createPorts = () => ({ board: { fetchSnapshot: () => null } })')), /a board without: statusEvents/],
  ]
  for (const [name, config, message] of refused) {
    it(`refuses ${name}, with what to fix`, () => {
      assert.throws(() => buildPorts(config()), message)
    })
  }

  it('checks the ports a module returned, one by one', () => {
    assert.deepEqual(checkModulePorts({}, 'm'), {})
    assert.throws(() => checkModulePorts({ writer: { assign: () => undefined } }, 'm'), /a writer without: setStatus, setReason/)
  })
})

describe('the reference rule for items from a module', () => {
  it('accepts 1 to 120 ASCII letters, digits, and . _ # -', () => {
    for (const ok of ['ENG-123', 'app#14', 'a.b_c-1#2', 'a'.repeat(120), '7f3a-9c2e-uuid']) assert.equal(isItemRef(ok), true, ok)
    for (const bad of ['', 'a'.repeat(121), 'owner/repo#12', 'PROJ:12', 'ENG 123', 'https://x/1', 'issueé']) assert.equal(isItemRef(bad), false, bad)
  })

  it('reports each item that does not fit, naming it, at most five', () => {
    const items = [issue(1), ...Array.from({ length: 8 }, (_, index) => issue(index + 2, { repo: 'a:b' }))]
    const problems = itemRefProblems(items)
    assert.equal(problems.length, 5)
    assert.match(problems[0] ?? '', /"a:b#2" does not fit/)
  })

  it('fails the read of a module whose item cannot be judged, and passes one that fits', () => {
    const bad = buildPorts(withModule(writeModule(BOARD_MODULE('{ itemId: "x", kind: "issue", repo: "ENG:team", number: 1, title: "t", state: "OPEN", author: null, status: "Backlog", reason: "None", since: null, owner: null, assignee: null }'))))
    assert.throws(() => bad.board.fetchSnapshot(NOW), /returned an item that cannot be judged: the reference "ENG:team#1"/)
    assert.equal(buildPorts(withModule(writeModule(BOARD_MODULE()))).board.fetchSnapshot(NOW).items.length, 1)
  })
})

describe('a board module that cannot be used, on the command line', () => {
  function runWith(args: readonly string[], input: string) {
    const state = tmp()
    mkdirSync(join(state, 'log'), { recursive: true })
    writeFileSync(join(state, 'config.json'), JSON.stringify({ ...base, adapters: { module: '/nonexistent/module.mjs' } }))
    const result = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SCRUM_STATE_DIR: state, HOME: state } })
    return { result, state }
  }

  it('answers a runtime call with a 503 the node retries, naming the module', () => {
    const { result } = runWith(['runtime'], JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'view' }))
    assert.equal(result.status, 1)
    const response = JSON.parse(result.stdout) as { error: { status: number; message: string } }
    assert.deepEqual([response.error.status, /does not exist/.test(response.error.message)], [503, true])
  })

  it('stops a command with the reason, and never reads GitHub instead', () => {
    const { result } = runWith(['lint'], '')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /scrum: the board module does not exist/)
  })

  it('lets a hook finish without stopping the session, and records the reason', () => {
    const { result, state } = runWith(['hook', 'Stop'], '{"session_id":"abc"}')
    assert.equal(result.status, 0)
    assert.match(spawnSync('cat', [join(state, 'log', 'errors.log')], { encoding: 'utf8' }).stdout, /hook: the board module does not exist/)
  })
})

describe('the action reader a module provides', () => {
  it('has to read tool calls (actionsOf), and a reader with the older commandsOf is refused by name', () => {
    assert.deepEqual(Object.keys(checkModulePorts({ actions: { actionsOf: () => [], shellPatterns: () => ({ post: '', pre: '' }) } }, 'm')), ['actions'])
    assert.throws(() => checkModulePorts({ actions: { commandsOf: () => [], shellPatterns: () => ({ post: '', pre: '' }) } }, 'm'), /actions without: actionsOf/)
  })
})
