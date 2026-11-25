import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ackCommand, parseFlags } from '../src/cli-commands.ts'
import { parseConfig } from '../src/config.ts'
import { paths, readJson } from '../src/store.ts'
import { config, NOW } from './helpers.ts'

describe('parseConfig', () => {
  it('when the board and team values are complete, uses them with the default check strength added', () => {
    const { wipLimit: _w, idleMinutes: _i, ...project } = config
    const parsed = parseConfig({ ...project, idleMinutes: 15 })
    assert.equal(parsed?.idleMinutes, 15)
    assert.equal(parsed?.wipLimit, 10)
  })

  it('does not use the config when a value is missing', () => {
    const { techlead: _t, ...rest } = config
    assert.equal(parseConfig(rest), null)
    assert.equal(parseConfig('x'), null)
  })
})

describe('parseFlags', () => {
  it('separates positional arguments from --name value pairs', () => {
    assert.deepEqual(parseFlags(['T-IDLE', 'SWE3', '--for', '2h', '--json']), {
      positional: ['T-IDLE', 'SWE3'],
      flags: { for: '2h', json: true },
    })
  })

  it("the word after a flag that takes no value (--once, --json, --refresh, --dry-run) stays a positional argument and is not taken as the flag's value", () => {
    assert.deepEqual(parseFlags(['--once', 'SWE3']), { positional: ['SWE3'], flags: { once: true } })
    assert.deepEqual(parseFlags(['SWE3', '--once']), { positional: ['SWE3'], flags: { once: true } })
    assert.deepEqual(parseFlags(['--once', 'SWE3', 'SWE2']), { positional: ['SWE3', 'SWE2'], flags: { once: true } })
    assert.deepEqual(parseFlags(['--json', 'x', '--refresh', 'y']), { positional: ['x', 'y'], flags: { json: true, refresh: true } })
    assert.deepEqual(parseFlags(['--dry-run', 'z']), { positional: ['z'], flags: { 'dry-run': true } })
  })

  it('a flag that takes a value (--for, --reason, --until, --since) takes the next word as its value', () => {
    assert.deepEqual(parseFlags(['T-IDLE', 'SWE3', '--reason', 'slot 05:45', '--for', '1h']), {
      positional: ['T-IDLE', 'SWE3'],
      flags: { reason: 'slot 05:45', for: '1h' },
    })
    assert.deepEqual(parseFlags(['--since', '2026-11-01']), { positional: [], flags: { since: '2026-11-01' } })
  })
})

describe('ackCommand', () => {
  it('writes an acknowledgement when a reason and an expiry are given', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-ack-')))
    const text = ackCommand(p, ['B-BLOCK-STALE', 'app#12'], { for: '2h', reason: 'Waiting for the night run' })
    assert.match(text, /Acknowledged: B-BLOCK-STALE app#12/)
    assert.equal(readJson<readonly { reason: string }[]>(p.acks, [])[0]?.reason, 'Waiting for the night run')
  })

  it('returns the usage and writes nothing when there is no reason', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-ack-')))
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '2h' }), /^Usage/)
    assert.deepEqual(readJson(p.acks, []), [])
  })

  it('a T-IDLE acknowledgement is written for a fixed reason up to 1 hour, and a slot records its start', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-ack-')))
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '1h', reason: "Waiting for the owner's answer" }, config, NOW), /Acknowledged: T-IDLE SWE3/)
    assert.match(ackCommand(p, ['T-IDLE', 'SWE2'], { for: '1h', reason: 'slot 15:30' }, config, NOW), /Acknowledged: T-IDLE SWE2/)
    const acks = readJson<readonly { subject: string; slotAt?: string }[]>(p.acks, [])
    assert.equal(acks.find((ack) => ack.subject === 'SWE3')?.slotAt, undefined)
    assert.equal(acks.find((ack) => ack.subject === 'SWE2')?.slotAt, '2026-10-08T06:30:00.000Z')
  })

  it('a T-IDLE acknowledgement writes nothing for a reason other than the fixed ones, an expiry longer than 1 hour, or when there is no config', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-ack-')))
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '1h', reason: 'Because of spare context capacity' }, config, NOW), /Spare context capacity cannot be a reason/)
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '2h', reason: "Waiting for the owner's answer" }, config, NOW), /at most 1 hour/)
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '1h', reason: "Waiting for the owner's answer" }, null, NOW), /There is no configuration/)
    assert.deepEqual(readJson(p.acks, []), [])
  })
})

describe('optional values of parseConfig', () => {
  it('fills in defaults when names and scripts are missing', () => {
    const { ownerLabel: _o, scripts: _s, ...rest } = config
    const parsed = parseConfig(rest)
    assert.equal(parsed?.ownerLabel, 'the owner')
    assert.deepEqual(parsed?.scripts, {})
  })
})

describe('writeShellPatterns', async () => {
  const { writeShellPatterns } = await import('../src/cli-commands.ts')
  const { bashActionReader } = await import('../src/adapters/github/action-reader.ts')
  const write = (p: ReturnType<typeof paths>, candidate: typeof config) => writeShellPatterns(p, candidate, bashActionReader(candidate))

  it('writes the patterns that bin/scrum reads, post on line 1 and pre on line 2', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-patterns-')))
    write(p, config)
    const [post, pre, dispatch] = readFileSync(p.shellPatterns, 'utf8').split('\n')
    assert.match(post ?? '', /set-status/)
    assert.equal(pre, 'set-status|bulk-status')
    assert.equal(dispatch, '0')
  })

  it('line 3 is 1 only when dispatch is enabled (it decides whether bin/scrum starts the member watch)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-patterns-')))
    write(p, { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: [] } })
    assert.equal(readFileSync(p.shellPatterns, 'utf8').split('\n')[2], '1')
  })

  it('does not rewrite when the content is the same (so it is not written on every hook)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-patterns-')))
    write(p, config)
    const before = statSync(p.shellPatterns).mtimeMs
    write(p, config)
    assert.equal(statSync(p.shellPatterns).mtimeMs, before)
  })
})
