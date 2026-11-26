import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import { teamViewProblem } from '../src/agency-runtime/validate.ts'
import { paths } from '../src/store.ts'
import { board, config } from './agency-runtime-board.ts'
import { fakePorts } from './fake-ports.ts'
import { NOW } from './helpers.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const deps = (): RuntimeDeps => ({ p: paths(mkdtempSync(join(tmpdir(), 'scrum-runtime-cmd-'))), config, now: NOW, ports: fakePorts(), spawnRefresh: () => undefined, spawnUsageIndex: () => undefined })
const call = (op: string, extra: object = {}) => JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op, ...extra })
const parse = (stdout: string) => JSON.parse(stdout) as { result?: any; error?: { status: number; message: string } }

describe('agency-runtime/1 describe', () => {
  it('reports the version, the operations (tokenUsage included), and the team label', () => {
    const output = runRuntime(call('describe'), deps())
    assert.equal(output.exitCode, 0)
    assert.deepEqual(parse(output.stdout), { result: { runtimes: ['agency-runtime/1'], ops: ['describe', 'view', 'decide', 'tokenUsage', 'activity'], label: 'app' } })
  })

  it('is one JSON line on stdout', () => {
    const { stdout } = runRuntime(call('describe'), deps())
    assert.equal(stdout.endsWith('\n'), true)
    assert.equal(stdout.trim().includes('\n'), false)
  })
})

describe('agency-runtime/1 requests', () => {
  const refused: readonly (readonly [string, string])[] = [
    ['input that is not JSON', 'describe'],
    ['an empty input', ''],
    ['JSON that is not an object', '[]'],
    ['another runtime version', JSON.stringify({ runtime: 'agency-runtime/2', org: 'acme', team: 'app', op: 'view' })],
    ['an unknown op', call('usage')],
    ['an org that is not an id', JSON.stringify({ runtime: 'agency-runtime/1', org: 'Acme', team: 'app', op: 'view' })],
    ['a decide without a decision', call('decide')],
  ]
  for (const [name, input] of refused) {
    it(`answers ${name} with a 400 and exit code 1`, () => {
      const output = runRuntime(input, deps())
      assert.equal(output.exitCode, 1)
      assert.equal(parse(output.stdout).error?.status, 400)
      assert.equal('result' in parse(output.stdout), false)
    })
  }

  it('answers 503 when the harness is not configured', () => {
    const output = runRuntime(call('describe'), null)
    assert.deepEqual([output.exitCode, parse(output.stdout).error?.status], [1, 503])
  })

  it('ignores request fields it does not know', () => {
    assert.equal(runRuntime(call('describe', { future: true }), deps()).exitCode, 0)
  })
})

describe('scrum runtime (the command)', () => {
  function stateDir(withBoard: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-runtime-state-'))
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
    if (withBoard) saveSnapshot(paths(dir), board(new Date()))
    mkdirSync(join(dir, 'sessions'))
    return dir
  }

  function scrum(dir: string | null, input: string) {
    const env = { ...process.env, SCRUM_SESSIONS_DIR: join(tmpdir(), 'scrum-runtime-no-sessions'), ...(dir === null ? { SCRUM_STATE_DIR: mkdtempSync(join(tmpdir(), 'scrum-runtime-unconfigured-')) } : { SCRUM_STATE_DIR: dir }) }
    const run = spawnSync(process.execPath, ['--no-warnings', CLI, 'runtime'], { input, env, encoding: 'utf8' })
    return { status: run.status, response: parse(run.stdout) }
  }

  it('reads one request from stdin and exits 0 with a result', () => {
    const { status, response } = scrum(stateDir(true), call('describe'))
    assert.deepEqual([status, response.result?.runtimes], [0, ['agency-runtime/1']])
  })

  it('answers a view with a valid TeamView', () => {
    const { status, response } = scrum(stateDir(true), call('view'))
    assert.equal(status, 0)
    assert.equal(teamViewProblem(response.result), null)
  })

  it('exits 1 with an error body when it is not configured', () => {
    const { status, response } = scrum(null, call('view'))
    assert.deepEqual([status, response.error?.status], [1, 503])
  })

  it('exits 1 with a 400 for input that is not a request', () => {
    const { status, response } = scrum(stateDir(true), 'not json')
    assert.deepEqual([status, response.error?.status], [1, 400])
  })
})
