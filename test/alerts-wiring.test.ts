import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alertsOf, DEFAULT_ALERTS, parseAlerts } from '../src/alerts/config.ts'
import { bashActionReader } from '../src/adapters/github/action-reader.ts'
import { osascriptArgs } from '../src/adapters/macos/notify.ts'
import { liaisonMessage } from '../src/alerts/liaison.ts'
import type { Notice } from '../src/alerts/types.ts'
import { itemsQuery } from '../src/adapters/github/project-board.ts'
import { writeShellPatterns } from '../src/cli-commands.ts'
import { parseConfig } from '../src/config.ts'
import { paths } from '../src/store.ts'
import { roleOf } from '../src/team/identity.ts'
import { config } from './helpers.ts'
import { alerts, enabled } from './alerts-fixtures.ts'

describe('parseAlerts', () => {
  it('enabled だけで、ほかは既定で埋める', () => {
    assert.deepEqual(parseAlerts({ enabled: true }), { ...DEFAULT_ALERTS, enabled: true })
    assert.deepEqual(DEFAULT_ALERTS.parkedLabels, ['epic:parked'])
    assert.equal(DEFAULT_ALERTS.epicPushMinutes, 1440)
    assert.equal(DEFAULT_ALERTS.emptyPushMinutes, 60)
    assert.equal(DEFAULT_ALERTS.isDesktopEnabled, true)
    assert.deepEqual(
      parseAlerts({ enabled: false, liaison: 'Desk', epicStallMinutes: 90, emptyEscalateMinutes: 15, isDesktopEnabled: false, parkedLabels: ['x'], epicPushMinutes: 30, emptyPushMinutes: 15 }),
      { enabled: false, liaison: 'Desk', epicStallMinutes: 90, emptyEscalateMinutes: 15, isDesktopEnabled: false, parkedLabels: ['x'], epicPushMinutes: 30, emptyPushMinutes: 15 },
    )
  })

  it('形が違えば、この機能だけを止める (undefined)', () => {
    const bad = [null, 'x', {}, { enabled: 'yes' }, { enabled: true, liaison: '' }, { enabled: true, liaison: 3 }, { enabled: true, epicStallMinutes: 0 }]
    bad.forEach((raw) => assert.equal(parseAlerts(raw), undefined))
    assert.equal(parseAlerts({ enabled: true, emptyEscalateMinutes: '30' }), undefined)
    assert.equal(parseAlerts({ enabled: true, isDesktopEnabled: 1 }), undefined)
    assert.equal(parseAlerts({ enabled: true, parkedLabels: 'epic:parked' }), undefined)
    assert.equal(parseAlerts({ enabled: true, parkedLabels: [1] }), undefined)
    assert.equal(parseAlerts({ enabled: true, epicPushMinutes: 0 }), undefined)
    assert.equal(parseAlerts({ enabled: true, emptyPushMinutes: -1 }), undefined)
  })

  it('config に alerts が無いか壊れていても、設定全体は読め、alerts は既定 (無効) になる', () => {
    assert.equal(alertsOf(config).enabled, false)
    assert.equal(parseConfig({ ...config, alerts: { enabled: 'yes' } })?.alerts, undefined)
    assert.equal(parseConfig({ ...config, alerts })?.alerts?.liaison, 'Liaison')
  })
})

describe('roleOf', () => {
  it('alerts が有効で、窓口の名前なら liaison。無効なら役なし', () => {
    assert.equal(roleOf('Liaison', enabled), 'liaison')
    assert.equal(roleOf('Liaison', { ...enabled, alerts: { ...alerts, enabled: false } }), null)
    assert.equal(roleOf('Liaison', { ...enabled, alerts: { ...alerts, liaison: undefined } }), null)
  })

  it('TechLead と部下の役は変わらない', () => {
    assert.equal(roleOf('TechLead', enabled), 'techlead')
    assert.equal(roleOf('SWE1', enabled), 'member')
    assert.equal(roleOf('someone', enabled), null)
    assert.equal(roleOf('TechLead', { ...enabled, alerts: { ...alerts, liaison: 'TechLead' } }), 'techlead')
  })
})

describe('writeShellPatterns の 4 行目', () => {
  const line4 = (candidate: typeof config) => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-patterns-')))
    writeShellPatterns(p, candidate, bashActionReader(candidate))
    return readFileSync(p.shellPatterns, 'utf8').split('\n')[3]
  }

  it('alerts が有効で窓口の名前があるときだけ 1。bin/scrum が窓口の待機を起こすかを決める', () => {
    assert.equal(line4(config), '0')
    assert.equal(line4(enabled), '1')
    assert.equal(line4({ ...enabled, alerts: { ...alerts, liaison: undefined } }), '0')
    assert.equal(line4({ ...enabled, alerts: { ...alerts, enabled: false } }), '0')
  })
})

describe('itemsQuery', () => {
  it('alerts が有効なら、dispatch が無効でも、子の親 (Epic) を取る。どちらも無効なら取らない', () => {
    const alertsOnly = { ...config, alerts }
    assert.match(itemsQuery(alertsOnly), /parent\{ number repository\{ nameWithOwner \} \}/)
    assert.doesNotMatch(itemsQuery(config), /parent\{/)
  })
})

describe('osascriptArgs', () => {
  it('本文と題は引数 (argv) で渡し、スクリプトの文字列には埋め込まない。音は指定しない', () => {
    const body = 'Epic "; do shell script "rm -rf ~"\n-x'
    const args = osascriptArgs('Heading "q"', body)
    const separator = args.indexOf('--')
    assert.deepEqual(args.slice(separator + 1), [body, 'Heading "q"'])
    const script = args.slice(0, separator).filter((arg) => arg !== '-e').join('\n')
    assert.equal(script.includes('rm -rf'), false)
    assert.equal(script.includes('Heading'), false)
    assert.match(script, /display notification \(item 1 of argv\) with title \(item 2 of argv\)/)
    assert.doesNotMatch(script, /sound/)
  })
})

describe('liaisonMessage', () => {
  const owner: Notice = { key: 'k1', kind: 'owner', text: '- E-STALL app#100: send the owner one PushNotification', desktop: { title: 't', body: 'b' } }
  const line: Notice = { key: 'k2', kind: 'idle-line', text: '- SWE1 has been idle for 10 minutes. Acknowledgement: none. Harness action: nothing sent yet' }

  it('オーナーへの通知を先に、空きの 1 行を後に並べ、macOS の通知も出していると添える', () => {
    assert.equal(
      liaisonMessage([line, owner], enabled),
      [
        'scrum-harness: notice for the liaison (decided by the harness; handle it without changing the content)',
        owner.text,
        line.text,
        '(The notice to the owner is also shown directly by the harness as a macOS notification, without sound)',
      ].join('\n'),
    )
  })

  it('オーナーへは送らないと決めた通知 (info) も、オーナーへの通知の後に、窓口への文へ並べる', () => {
    const info: Notice = { key: 'k3:held', kind: 'info', text: '- E-STALL app#100: the owner was already notified at 16:00, so it is not sent this time' }
    assert.deepEqual(liaisonMessage([info, line, owner], enabled).split('\n').slice(1, 4), [owner.text, info.text, line.text])
  })

  it('空きの 1 行だけなら、通知の添え書きは付けない。macOS の通知が無効でも付けない', () => {
    assert.doesNotMatch(liaisonMessage([line], enabled), /macOS/)
    const quiet = { ...enabled, alerts: { ...alerts, isDesktopEnabled: false } }
    assert.doesNotMatch(liaisonMessage([owner], quiet), /macOS/)
  })
})
