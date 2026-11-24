import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alertsCommand } from '../src/alerts/command.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { gh } from '../src/adapters/github/gh.ts'
import { projectBoardSource } from '../src/adapters/github/project-board.ts'
import type { Snapshot } from '../src/board/types.ts'
import { paths } from '../src/store.ts'
import { config, NOW, snapshot } from './helpers.ts'
import { child, enabled, epic } from './alerts-fixtures.ts'
import { fakePorts } from './fake-ports.ts'

/** 取り直しを、渡した関数で置き換えたポート。関数は、取り直した控えを返す。 */
const refreshing = (fetchSnapshot: () => Snapshot) => fakePorts({ board: { ...fakePorts().board, fetchSnapshot } })

describe('alertsCommand (scrum alerts)', () => {
  it('alerts が有効でなければ、何もせず、理由を返す', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-cmd-')))
    assert.match(alertsCommand(p, config, NOW, fakePorts()), /alerts is not enabled/)
  })

  it('有効なら、検知を 1 回進め、macOS の通知を、まだなら出し、動く人のいない Epic と、渡せる issue が無い部下の数を返す', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-cmd-')))
    const board = { ...snapshot([epic(), child(101, { status: 'Next' })]), fetchedAt: NOW.toISOString() }
    saveSnapshot(p, board)
    const sent: string[] = []
    const notify = (_title: string, body: string) => sent.push(body)
    assert.equal(alertsCommand(p, enabled, NOW, fakePorts({ notify })), 'Advanced the stall detection. Epics with nobody moving: 1; members with nothing to hand over: 0')
    assert.equal(sent.length, 0)
    alertsCommand(p, enabled, new Date(NOW.getTime() + 60 * 60_000), fakePorts({ notify }))
    assert.equal(sent.length, 1)
  })
})

describe('alertsCommand の控えの取り直し', () => {
  const stale = (p: ReturnType<typeof paths>) => saveSnapshot(p, { ...snapshot([epic(), child(101, { status: 'Next' })]), fetchedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString() })

  it('控えが古ければ、検知の前に取り直す (launchd の夜は、ほかに取り直す人がいない)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-refresh-')))
    stale(p)
    const order: string[] = []
    alertsCommand(
      p,
      enabled,
      NOW,
      refreshing(() => {
        order.push('refresh')
        throw new Error('the retry was only attempted')
      }),
    )
    assert.deepEqual(order, ['refresh'])
  })

  it('控えが新しければ、取り直さない', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-refresh-')))
    saveSnapshot(p, { ...snapshot([epic()]), fetchedAt: NOW.toISOString() })
    let called = false
    alertsCommand(
      p,
      enabled,
      NOW,
      refreshing(() => {
        called = true
        throw new Error('not called')
      }),
    )
    assert.equal(called, false)
  })

  it('取り直した後の控えで、検知する (取り直しが控えを新しくすれば、その控えを使う)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-refresh-')))
    stale(p)
    const refreshed = { ...snapshot([epic(), child(101, { status: 'Next' })]), fetchedAt: NOW.toISOString() }
    const text = alertsCommand(p, enabled, NOW, refreshing(() => refreshed))
    assert.match(text, /Epics with nobody moving: 1/)
  })

  it('本物の取り直しは、gh を呼ぶ前に、試した時刻を書く (gh が使えなくても、5 分ごとに叩き続けない)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-refresh-')))
    stale(p)
    const savedPath = process.env.PATH
    process.env.PATH = mkdtempSync(join(tmpdir(), 'scrum-no-gh-'))
    try {
      alertsCommand(p, enabled, NOW, fakePorts({ board: projectBoardSource(gh, enabled) }))
    } finally {
      process.env.PATH = savedPath
    }
    assert.equal(readFileSync(p.refreshAttempt, 'utf8').includes(NOW.toISOString()), true)
  })
})

describe('launchd の雛形', () => {
  const plist = readFileSync(fileURLToPath(new URL('../launchd/scrum-alerts.plist', import.meta.url)), 'utf8')

  it('5 分ごとに、bin/scrum alerts を流し、読み込んだ直後には流さない', () => {
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/)
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/)
    assert.match(plist, /<string>\{\{SCRUM_DIR\}\}\/bin\/scrum<\/string>\s*<string>alerts<\/string>/)
  })

  it('置き換える場所 ({{HOME}}、{{SCRUM_DIR}}、{{PATH}}) 以外に、決め打ちのパスを持たない (node と gh の場所は、置くときに読む)', () => {
    assert.doesNotMatch(plist.replaceAll('{{HOME}}', '').replaceAll('{{SCRUM_DIR}}', '').replaceAll('{{PATH}}', ''), /\/Users\/|\/opt\/homebrew|\/usr\/local/)
    assert.match(plist, /<key>PATH<\/key>\s*<string>\{\{PATH\}\}<\/string>/)
  })
})

describe('launchd/render.sh (雛形に、この Mac の値を入れる)', () => {
  const script = fileURLToPath(new URL('../launchd/render.sh', import.meta.url))
  const fakeTool = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, name), 0o755)
  }
  const render = (pathValue: string) => spawnSync('/bin/bash', [script], { encoding: 'utf8', env: { PATH: pathValue, HOME: '/home/user' } })
  /** A directory holding only the system tools render.sh needs, so "node or gh is missing" does not depend on what the host has in /usr/bin. */
  const systemTools = () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-render-tools-'))
    for (const name of ['dirname', 'sed', 'env']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
      symlinkSync(found, join(dir, name))
    }
    return dir
  }

  it('{{ を残さず、PATH に node と gh のあるディレクトリを入れる (node と gh が別の場所でも)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scrum-render-'))
    fakeTool(join(root, 'nodebin'), 'node')
    fakeTool(join(root, 'ghbin'), 'gh')
    const result = render(`${join(root, 'nodebin')}:${join(root, 'ghbin')}:/usr/bin:/bin`)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /\{\{/)
    assert.match(result.stdout, new RegExp(`<key>PATH</key>\\s*<string>${join(root, 'nodebin')}:${join(root, 'ghbin')}:/usr/bin:/bin</string>`))
    assert.match(result.stdout, /<string>\/home\/user\/\.claude\/scrum\/log\/alerts-launchd\.log<\/string>/)
    assert.match(result.stdout, /<string>[^<]*\/bin\/scrum<\/string>\s*<string>alerts<\/string>/)
  })

  it('node と gh が同じ場所なら、1 つにまとめる', () => {
    const root = mkdtempSync(join(tmpdir(), 'scrum-render-'))
    fakeTool(join(root, 'bin'), 'node')
    fakeTool(join(root, 'bin'), 'gh')
    const result = render(`${join(root, 'bin')}:/usr/bin:/bin`)
    assert.match(result.stdout, new RegExp(`<string>${join(root, 'bin')}:/usr/bin:/bin</string>`))
  })

  it('node か gh が見つからなければ、何も出さず、理由を出して止まる', () => {
    const root = mkdtempSync(join(tmpdir(), 'scrum-render-'))
    fakeTool(join(root, 'bin'), 'node')
    const tools = systemTools()
    const noGh = render(`${join(root, 'bin')}:${tools}`)
    assert.equal(noGh.status, 1)
    assert.equal(noGh.stdout, '')
    assert.match(noGh.stderr, /gh not found/)
    const emptyDir = mkdtempSync(join(tmpdir(), 'scrum-render-empty-'))
    const noNode = render(`${emptyDir}:${tools}`)
    assert.equal(noNode.status, 1)
    assert.match(noNode.stderr, /node not found/)
  })

  it('置き換えた後に、plutil の検査を通る (macOS のときだけ)', { skip: process.platform !== 'darwin' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'scrum-render-'))
    fakeTool(join(root, 'bin'), 'node')
    fakeTool(join(root, 'bin'), 'gh')
    const file = join(root, 'test.plist')
    writeFileSync(file, render(`${join(root, 'bin')}:/usr/bin:/bin`).stdout)
    const result = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })
})
