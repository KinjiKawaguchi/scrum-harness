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
  it('ボードとチームの値がそろっていれば、検査の強さの既定値を足して使う', () => {
    const { wipLimit: _w, idleMinutes: _i, ...project } = config
    const parsed = parseConfig({ ...project, idleMinutes: 15 })
    assert.equal(parsed?.idleMinutes, 15)
    assert.equal(parsed?.wipLimit, 10)
  })

  it('欠けた値があれば使わない', () => {
    const { techlead: _t, ...rest } = config
    assert.equal(parseConfig(rest), null)
    assert.equal(parseConfig('x'), null)
  })
})

describe('parseFlags', () => {
  it('位置引数と --名前 値 を分ける', () => {
    assert.deepEqual(parseFlags(['T-IDLE', 'SWE3', '--for', '2h', '--json']), {
      positional: ['T-IDLE', 'SWE3'],
      flags: { for: '2h', json: true },
    })
  })

  it('値を取らない旗 (--once、--json、--refresh、--dry-run) の次の語は、旗の値にせず、位置引数のままにする', () => {
    assert.deepEqual(parseFlags(['--once', 'SWE3']), { positional: ['SWE3'], flags: { once: true } })
    assert.deepEqual(parseFlags(['SWE3', '--once']), { positional: ['SWE3'], flags: { once: true } })
    assert.deepEqual(parseFlags(['--once', 'SWE3', 'SWE2']), { positional: ['SWE3', 'SWE2'], flags: { once: true } })
    assert.deepEqual(parseFlags(['--json', 'x', '--refresh', 'y']), { positional: ['x', 'y'], flags: { json: true, refresh: true } })
    assert.deepEqual(parseFlags(['--dry-run', 'z']), { positional: ['z'], flags: { 'dry-run': true } })
  })

  it('値を取る旗 (--for、--reason、--until、--since) は、次の語を値にする', () => {
    assert.deepEqual(parseFlags(['T-IDLE', 'SWE3', '--reason', '枠 05:45', '--for', '1h']), {
      positional: ['T-IDLE', 'SWE3'],
      flags: { reason: '枠 05:45', for: '1h' },
    })
    assert.deepEqual(parseFlags(['--since', '2026-11-01']), { positional: [], flags: { since: '2026-11-01' } })
  })
})

describe('ackCommand', () => {
  it('理由と期限があれば受け入れを書く', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-ack-')))
    const text = ackCommand(p, ['B-BLOCK-STALE', 'app#12'], { for: '2h', reason: '今夜の作業待ち' })
    assert.match(text, /受け入れた: B-BLOCK-STALE app#12/)
    assert.equal(readJson<readonly { reason: string }[]>(p.acks, [])[0]?.reason, '今夜の作業待ち')
  })

  it('理由が無ければ使い方を返し、何も書かない', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-ack-')))
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '2h' }), /^使い方/)
    assert.deepEqual(readJson(p.acks, []), [])
  })

  it('T-IDLE の受け入れは、決まった理由と 1 時間までなら書き、枠には枠の始まりを残す', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-ack-')))
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '1h', reason: 'オーナーの答え待ち' }, config, NOW), /受け入れた: T-IDLE SWE3/)
    assert.match(ackCommand(p, ['T-IDLE', 'SWE2'], { for: '1h', reason: '枠 15:30' }, config, NOW), /受け入れた: T-IDLE SWE2/)
    const acks = readJson<readonly { subject: string; slotAt?: string }[]>(p.acks, [])
    assert.equal(acks.find((ack) => ack.subject === 'SWE3')?.slotAt, undefined)
    assert.equal(acks.find((ack) => ack.subject === 'SWE2')?.slotAt, '2026-10-08T06:30:00.000Z')
  })

  it('T-IDLE の受け入れは、決まった理由以外、1 時間より長い期限、設定が無いときは、何も書かない', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-ack-')))
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '1h', reason: 'コンテキストの余力のため' }, config, NOW), /コンテキストの余力は理由にできない/)
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '2h', reason: 'オーナーの答え待ち' }, config, NOW), /最長 1 時間/)
    assert.match(ackCommand(p, ['T-IDLE', 'SWE3'], { for: '1h', reason: 'オーナーの答え待ち' }, null, NOW), /設定が無い/)
    assert.deepEqual(readJson(p.acks, []), [])
  })
})

describe('parseConfig の任意の値', () => {
  it('呼び方とスクリプトが無ければ既定値を入れる', () => {
    const { ownerLabel: _o, scripts: _s, ...rest } = config
    const parsed = parseConfig(rest)
    assert.equal(parsed?.ownerLabel, 'オーナー')
    assert.deepEqual(parsed?.scripts, {})
  })
})

describe('writeShellPatterns', async () => {
  const { writeShellPatterns } = await import('../src/cli-commands.ts')

  it('bin/scrum が読む型を、1行目に post、2行目に pre で書く', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-patterns-')))
    writeShellPatterns(p, config)
    const [post, pre, dispatch] = readFileSync(p.shellPatterns, 'utf8').split('\n')
    assert.match(post ?? '', /set-status/)
    assert.equal(pre, 'set-status|bulk-status')
    assert.equal(dispatch, '0')
  })

  it('3 行目は、dispatch が有効なときだけ 1 にする (bin/scrum が部下の待機を起こすかを決める)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-patterns-')))
    writeShellPatterns(p, { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: [] } })
    assert.equal(readFileSync(p.shellPatterns, 'utf8').split('\n')[2], '1')
  })

  it('中身が同じなら書き直さない (フックのたびに書かない)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-patterns-')))
    writeShellPatterns(p, config)
    const before = statSync(p.shellPatterns).mtimeMs
    writeShellPatterns(p, config)
    assert.equal(statSync(p.shellPatterns).mtimeMs, before)
  })
})
