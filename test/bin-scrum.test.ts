import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/scrum', import.meta.url))

/** node の代わりに、呼ばれたことだけを記録する偽物を PATH の先頭に置いて、bin/scrum の振り分けを見る。 */
function run(role: string, patterns: string, args: readonly string[]): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-bin-'))
  const calls = join(dir, 'calls')
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'node'), `#!/bin/sh\necho called >> "${calls}"\n`)
  chmodSync(join(dir, 'bin', 'node'), 0o755)
  mkdirSync(join(dir, 'state', 'identity'), { recursive: true })
  mkdirSync(join(dir, 'state', 'cache'))
  writeFileSync(join(dir, 'state', 'identity', 'abc.json'), `{\n "name": "x",\n "role": "${role}"\n}\n`)
  writeFileSync(join(dir, 'state', 'cache', 'shell-patterns'), patterns)
  const env = { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, SCRUM_STATE_DIR: join(dir, 'state'), HOME: dir }
  const result = spawnSync('/bin/sh', [BIN, ...args], { input: '{"session_id":"abc"}', env, encoding: 'utf8' })
  assert.equal(result.status, 0)
  return existsSync(calls) && readFileSync(calls, 'utf8').includes('called')
}

const patterns = (dispatch: string, alerts: string) => `post\npre\n${dispatch}\n${alerts}\n`

describe('bin/scrum の窓口の振り分け', () => {
  it('窓口は、4 行目が 1 のときだけ、待機 (watch) で node を起こす', () => {
    assert.equal(run('liaison', patterns('0', '1'), ['watch']), true)
    assert.equal(run('liaison', patterns('1', '0'), ['watch']), false)
    assert.equal(run('liaison', 'post\npre\n', ['watch']), false)
  })

  it('窓口は、待機以外のフック (Stop、PostToolUse、SessionStart) では node を起こさない', () => {
    for (const event of ['Stop', 'PostToolUse', 'SessionStart', 'UserPromptSubmit']) {
      assert.equal(run('liaison', patterns('1', '1'), ['hook', event]), false, event)
    }
  })

  it('部下は 3 行目が 1 のときだけ、TechLead は常に、待機で node を起こす。チームの外は起こさない', () => {
    assert.equal(run('member', patterns('1', '0'), ['watch']), true)
    assert.equal(run('member', patterns('0', '1'), ['watch']), false)
    assert.equal(run('techlead', patterns('0', '0'), ['watch']), true)
    assert.equal(run('none', patterns('1', '1'), ['watch']), false)
  })
})

/** 偽の node を置いた状態の置き場を作り、bin/scrum を何度でも呼べるようにする。events.jsonl に足された行を返す。 */
function hookSandbox(role: string, options: { readonly withLogDir?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-bin-act-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'node'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'bin', 'node'), 0o755)
  mkdirSync(join(dir, 'state', 'identity'), { recursive: true })
  mkdirSync(join(dir, 'state', 'cache'))
  if (options.withLogDir !== false) mkdirSync(join(dir, 'state', 'log'))
  if (role !== '') writeFileSync(join(dir, 'state', 'identity', 'abc.json'), `{\n "name": "x",\n "role": "${role}"\n}\n`)
  writeFileSync(join(dir, 'state', 'cache', 'shell-patterns'), patterns('0', '0'))
  const env = { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, SCRUM_STATE_DIR: join(dir, 'state'), HOME: dir }
  const events = join(dir, 'state', 'log', 'events.jsonl')
  const due = join(dir, 'state', 'cache', 'activity-due')
  return {
    due,
    call(args: readonly string[]): void {
      const result = spawnSync('/bin/sh', [BIN, ...args], { input: '{"session_id":"abc"}', env, encoding: 'utf8' })
      assert.equal(result.status, 0)
    },
    lines: (): readonly Record<string, string>[] =>
      existsSync(events) ? readFileSync(events, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, string>) : [],
  }
}

describe('bin/scrum の動きの記録 (activity)', () => {
  it('TechLead、部下、窓口のどのセッションでも、PostToolUse が動きの記録を 1 行足す (役を残す)', () => {
    for (const role of ['techlead', 'member', 'liaison']) {
      const sandbox = hookSandbox(role)
      sandbox.call(['hook', 'PostToolUse'])
      const lines = sandbox.lines()
      assert.equal(lines.length, 1, role)
      assert.equal(lines[0]?.type, 'activity', role)
      assert.equal(lines[0]?.role, role)
      assert.match(lines[0]?.at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/, role)
    }
  })

  it('役が決まっていない (識別の控えが無い) セッションは足さない。チームの外かもしれないため', () => {
    const sandbox = hookSandbox('')
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 0)
  })

  it('UserPromptSubmit、SessionStart、Stop では足さない (週の上限の間も、予定の実行の入力でこれらのフックは通る)', () => {
    for (const event of ['UserPromptSubmit', 'SessionStart', 'Stop']) {
      for (const role of ['member', 'techlead', 'liaison']) {
        const sandbox = hookSandbox(role)
        sandbox.call(['hook', event])
        assert.equal(sandbox.lines().length, 0, `${role} ${event}`)
      }
    }
  })

  it('チームの外のセッションと、PreToolUse、Notification、SessionEnd、statusline では足さない', () => {
    const outside = hookSandbox('none')
    outside.call(['hook', 'PostToolUse'])
    assert.equal(outside.lines().length, 0)
    for (const args of [['hook', 'PreToolUse'], ['hook', 'Notification'], ['hook', 'SessionEnd'], ['statusline']]) {
      const sandbox = hookSandbox('techlead')
      sandbox.call(args)
      assert.equal(sandbox.lines().length, 0, args.join(' '))
    }
  })

  it('足した後、次の 10 分は足さない。次に書く時刻 (activity-due) が過ぎたら足す', () => {
    const sandbox = hookSandbox('member')
    sandbox.call(['hook', 'PostToolUse'])
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 1)
    // 次に書く時刻は、足した時刻の 10 分後 (9 分 〜 11 分の間に入る)
    const untilDue = statSync(sandbox.due).mtimeMs - Date.now()
    assert.ok(untilDue > 9 * 60_000 && untilDue <= 10 * 60_000 + 2000, `${untilDue} ms until the next write`)
    const inOneMinute = new Date(Date.now() + 60_000)
    utimesSync(sandbox.due, inOneMinute, inOneMinute)
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 1)
    const oneMinuteAgo = new Date(Date.now() - 60_000)
    utimesSync(sandbox.due, oneMinuteAgo, oneMinuteAgo)
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 2)
  })

  it('log のディレクトリが無ければ、何も足さず、フックは 0 で終わる', () => {
    const sandbox = hookSandbox('member', { withLogDir: false })
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 0)
    assert.equal(existsSync(sandbox.due), false)
  })
})
