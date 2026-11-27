import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newestMtime, serveRuntime, type RuntimeServerOptions } from '../src/runtime-server.ts'
import { writeMetricsState } from './fixtures/metrics-state.ts'

const BIN = fileURLToPath(new URL('../bin/scrum', import.meta.url))
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

/** What a client sends over the socket, and what comes back until the server closes the connection. */
function ask(socket: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(socket)
    let received = ''
    client.setEncoding('utf8')
    client.on('data', (chunk: string) => (received += chunk))
    client.on('close', () => resolve(received))
    client.on('error', reject)
    client.on('connect', () => client.write(text))
  })
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function untilListening(socket: string): Promise<void> {
  for (let tries = 0; tries < 100; tries += 1) {
    if (existsSync(socket)) return
    await wait(50)
  }
  throw new Error('the server did not listen')
}

describe('the runtime server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-rt-server-'))
  const stateDir = join(dir, 'state')
  mkdirSync(stateDir)
  writeFileSync(join(stateDir, 'config.json'), '{}')
  let n = 0
  const socket = (): string => join(dir, `s${(n += 1)}.sock`)

  function start(socketPath: string, overrides: Partial<RuntimeServerOptions> = {}) {
    const calls: { stateDir: string; input: string }[] = []
    const ended = serveRuntime({ socketPath, answer: (state, input) => (calls.push({ stateDir: state, input }), `{"result":${JSON.stringify(input.length)}}\n`), sourceStamp: () => 'a', ...overrides })
    return { calls, ended }
  }

  it('answers a request for a state directory, once the JSON is complete, and closes the connection', async () => {
    const path = socket()
    const { calls, ended } = start(path)
    await untilListening(path)
    assert.equal(await ask(path, `${stateDir}\n{"op":"view"}`), '{"result":13}\n')
    assert.deepEqual(calls, [{ stateDir, input: '{"op":"view"}' }])
    assert.equal(await ask(path, '!shutdown\n'), 'ok\n')
    assert.equal(await ended, 'stopped')
    assert.equal(existsSync(path), false)
  })

  it('takes a request that arrives in pieces, and one the client ends before it is whole', async () => {
    const path = socket()
    const { calls, ended } = start(path)
    await untilListening(path)
    const pieces = new Promise<string>((resolve) => {
      const client = connect(path)
      let received = ''
      client.setEncoding('utf8')
      client.on('data', (chunk: string) => (received += chunk))
      client.on('close', () => resolve(received))
      client.on('connect', () => {
        client.write(`${stateDir}\n{"op":`)
        setTimeout(() => client.write('"view"}'), 50)
      })
    })
    assert.equal(await pieces, '{"result":13}\n')
    await new Promise<void>((resolve) => {
      const client = connect(path)
      client.on('close', () => resolve())
      client.on('data', () => undefined)
      client.on('connect', () => client.end(`${stateDir}\n{"op":`))
    })
    assert.equal(calls.at(-1)?.input, '{"op":')
    await ask(path, '!shutdown\n')
    await ended
  })

  it('answers 503 for a state directory that is not one (relative, or with no configuration), and when the answer fails', async () => {
    const path = socket()
    const { ended } = start(path, { answer: () => { throw new Error('boom') } })
    await untilListening(path)
    assert.match(await ask(path, 'relative/dir\n{"op":"view"}'), /^\{"error":\{"status":503,"message":"scrum-harness is not configured"\}\}\n$/)
    assert.match(await ask(path, `${dir}\n{"op":"view"}`), /not configured/)
    assert.match(await ask(path, `${stateDir}\n{"op":"view"}`), /^\{"error":\{"status":503,"message":"the runtime cannot act now: boom"\}\}\n$/)
    await ask(path, '!shutdown\n')
    await ended
  })

  it('ends without an answer when the source changed, so the caller answers by itself', async () => {
    const path = socket()
    let stamp = 'a'
    const { ended } = start(path, { sourceStamp: () => stamp })
    await untilListening(path)
    assert.equal(await ask(path, `${stateDir}\n{"op":"view"}`), '{"result":13}\n')
    stamp = 'b'
    await wait(1100)
    assert.equal(await ask(path, `${stateDir}\n{"op":"view"}`), '')
    assert.equal(await ended, 'source')
    assert.equal(existsSync(path), false)
  })

  it('ends when it has been idle, and when it has run its time', async () => {
    const idle = socket()
    assert.equal(await start(idle, { idleMs: 100 }).ended, 'idle')
    const old = socket()
    assert.equal(await start(old, { maxAgeMs: 100 }).ended, 'age')
  })

  it('leaves a server that already answers alone, and takes the place of a socket nobody listens on', async () => {
    const path = socket()
    const first = start(path)
    await untilListening(path)
    assert.equal(await start(path).ended, 'already')
    assert.equal(await ask(path, `${stateDir}\n{"op":"view"}`), '{"result":13}\n')
    await ask(path, '!shutdown\n')
    await first.ended
    writeFileSync(path, '')
    const second = start(path)
    await untilListening(path)
    await wait(50)
    assert.equal(await ask(path, `${stateDir}\n{"op":"view"}`), '{"result":13}\n')
    await ask(path, '!shutdown\n')
    await second.ended
  })

  it('knows when the source changed by the newest modification time of its files', () => {
    const root = mkdtempSync(join(tmpdir(), 'scrum-rt-src-'))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.ts'), '')
    writeFileSync(join(root, 'notes.txt'), '')
    const before = newestMtime(root)
    utimesSync(join(root, 'notes.txt'), new Date(), new Date(Date.now() + 5000))
    assert.equal(newestMtime(root), before)
    utimesSync(join(root, 'sub', 'a.ts'), new Date(), new Date(Date.now() + 5000))
    assert.notEqual(newestMtime(root), before)
  })
})

describe('scrum runtime through bin/scrum', () => {
  const hasNc = spawnSync('sh', ['-c', 'command -v nc'], { encoding: 'utf8' }).status === 0
  const dir = mkdtempSync(join(tmpdir(), 'scrum-rt-bin-'))
  const state = join(dir, 'state')
  writeMetricsState(state, { repo: 'acme/app', pullRequests: [{ number: 12, by: 'SWE1' }] })
  const sock = join(dir, 'r.sock')
  const env = { ...process.env, SCRUM_STATE_DIR: state, SCRUM_RUNTIME_SOCKET: sock, SCRUM_NAME: '', CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', SCRUM_SESSIONS_DIR: '' }
  const call = (request: object, extra: Record<string, string> = {}) =>
    spawnSync(BIN, ['runtime'], { input: JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', ...request }), env: { ...env, ...extra }, encoding: 'utf8' })
  const metrics = { op: 'participantMetrics', days: 3, utcOffsetMinutes: 0 }

  after(() => {
    spawnSync('node', ['--no-warnings', CLI, 'runtime-stop'], { env, encoding: 'utf8' })
  })

  it('answers by itself when there is no server, and starts one for the next call', { skip: !hasNc }, async () => {
    const first = call(metrics)
    assert.equal(first.status, 0, first.stderr)
    const direct = JSON.parse(first.stdout) as { result: { participants: unknown[] } }
    assert.equal(direct.result.participants.length, 2)
    await untilListening(sock)
    await wait(300)
  })

  it('then answers through the server, with the same answer, and the exit code of an error', { skip: !hasNc }, () => {
    const direct = call(metrics, { SCRUM_RUNTIME_DIRECT: '1' })
    const served = call(metrics)
    assert.equal(served.status, 0, served.stderr)
    assert.equal(JSON.parse(served.stdout).result.participants.length, JSON.parse(direct.stdout).result.participants.length)
    const bad = call({ op: 'participantMetrics', days: 0 })
    assert.deepEqual([bad.status, JSON.parse(bad.stdout).error.status], [1, 400])
  })

  it('answers a decision by itself, and a call that sets CODEX_HOME by itself, not through the server', { skip: !hasNc }, () => {
    const decision = call({ op: 'decide', decision: { kind: 'answer', target: 'r-20260101-000000-aaaa', by: 'alice', byParticipant: 'owner', payload: { text: 'x' } } })
    assert.deepEqual([decision.status, JSON.parse(decision.stdout).error.status], [1, 404])
    assert.equal(call(metrics, { CODEX_HOME: dir }).status, 0)
  })

  it('answers for every state directory the calls name, from one server', { skip: !hasNc }, () => {
    const other = join(dir, 'other')
    writeMetricsState(other, { repo: 'acme/other', pullRequests: [{ number: 7, by: 'SWE2' }] })
    const a = JSON.parse(call(metrics).stdout).result.pullRequests
    const b = JSON.parse(call(metrics, { SCRUM_STATE_DIR: other }).stdout).result.pullRequests
    assert.deepEqual([a, b], [[{ repo: 'acme/app', number: 12, by: 'SWE1' }], [{ repo: 'acme/other', number: 7, by: 'SWE2' }]])
  })

  it('is stopped by runtime-stop, which removes the socket', { skip: !hasNc }, async () => {
    const stop = spawnSync('node', ['--no-warnings', CLI, 'runtime-stop'], { env, encoding: 'utf8' })
    assert.equal(stop.status, 0)
    for (let tries = 0; tries < 40 && existsSync(sock); tries += 1) await wait(50)
    assert.equal(existsSync(sock), false)
  })
})
