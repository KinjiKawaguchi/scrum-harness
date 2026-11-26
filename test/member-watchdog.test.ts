import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeLauncher } from '../src/adapters/claude-code/launch.ts'
import { codexLauncher } from '../src/adapters/codex/launch.ts'
import { lintAll } from '../src/findings/lint.ts'
import { memberCommand, type WatchdogDeps } from '../src/members/command.ts'
import { parseLaunch } from '../src/members/config.ts'
import { lintStartFailures } from '../src/members/rules.ts'
import { clearStartFailure, readStartFailures, recordStartFailure } from '../src/members/start-failures.ts'
import { screenSummary, showsLife, waitForLife, watchdogOf } from '../src/members/watchdog.ts'
import type { LaunchPlan } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import type { MemberState, SessionSignal } from '../src/team/types.ts'
import type { Config } from '../src/config.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, NOW } from './helpers.ts'

const signal = (name: string, updatedAt: Date, extra: Partial<SessionSignal> = {}): SessionSignal => ({ sessionId: `s-${name}`, name, state: 'idle', since: updatedAt.toISOString(), updatedAt: updatedAt.toISOString(), isAlive: true, nameSince: null, ...extra })

/** A clock that only moves when the watchdog sleeps, so no test waits. */
function clock(start: Date = NOW) {
  let at = start.getTime()
  return { now: () => new Date(at), sleep: (milliseconds: number) => void (at += milliseconds), advance: (milliseconds: number) => void (at += milliseconds) }
}

describe('the startup watchdog\'s settings', () => {
  it('is off unless set, on by default for Codex, and takes the settings of the member', () => {
    assert.equal(watchdogOf({}), null)
    assert.deepEqual(watchdogOf({ product: 'codex' }), { seconds: 60, retries: 2 })
    assert.deepEqual(watchdogOf({ product: 'codex', startupSeconds: 30, startupRetries: 0 }), { seconds: 30, retries: 0 })
    assert.deepEqual(watchdogOf({ startupSeconds: 10 }), { seconds: 10, retries: 2 })
  })

  it('is read from the launch section, and refused outside 5 to 600 seconds or 0 to 5 retries', () => {
    assert.deepEqual(parseLaunch({ tmuxSession: 't', members: { A: { startupSeconds: 45, startupRetries: 1 } } })?.members.A, { startupSeconds: 45, startupRetries: 1 })
    for (const bad of [{ startupSeconds: 4 }, { startupSeconds: 601 }, { startupSeconds: 1.5 }, { startupRetries: 6 }, { startupRetries: -1 }, { startupRetries: '2' }]) {
      assert.equal(parseLaunch({ tmuxSession: 't', members: { A: bad } }), undefined, JSON.stringify(bad))
    }
  })
})

describe('a sign of life', () => {
  const since = NOW
  it('is a live session of that name heard from since the start', () => {
    assert.equal(showsLife([signal('CodexA', new Date(NOW.getTime() + 5000))], 'CodexA', since), true)
    assert.equal(showsLife([signal('CodexA (2)', new Date(NOW.getTime() + 5000))], 'CodexA', since), true)
  })

  it('is not an older heartbeat, a dead or ended session, or another name', () => {
    assert.equal(showsLife([signal('CodexA', new Date(NOW.getTime() - 5000))], 'CodexA', since), false)
    assert.equal(showsLife([signal('CodexA', new Date(NOW.getTime() + 5000), { isAlive: false })], 'CodexA', since), false)
    assert.equal(showsLife([signal('CodexA', new Date(NOW.getTime() + 5000), { state: 'ended' })], 'CodexA', since), false)
    assert.equal(showsLife([signal('Other', new Date(NOW.getTime() + 5000))], 'CodexA', since), false)
  })

  it('is waited for until the time is up, and returns at once when it shows', () => {
    const time = clock()
    let polls = 0
    const never = waitForLife('CodexA', NOW, 10, { now: time.now, sleep: time.sleep, signals: () => (polls += 1, []) })
    assert.deepEqual([never, polls >= 5, time.now().getTime() - NOW.getTime() >= 10_000], [false, true, true])
    const later = clock()
    const alive = waitForLife('CodexA', NOW, 60, { now: later.now, sleep: later.sleep, signals: () => (later.now().getTime() - NOW.getTime() >= 4000 ? [signal('CodexA', later.now())] : []) })
    assert.deepEqual([alive, later.now().getTime() - NOW.getTime()], [true, 4000])
  })
})

describe('starting with a watchdog', () => {
  let p: Paths
  let started: string[]
  let stopped: string[]
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-watchdog-')))
    mkdirSync(join(p.dir, 'cache'), { recursive: true })
    started = []
    stopped = []
  })

  const config = (spec: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-watchdog-dir-'))
    writeFileSync(join(dir, 'brief.txt'), 'You are CodexA.')
    return { ...base, members: ['CodexA'], launch: parseLaunch({ tmuxSession: 'team', members: { CodexA: { dir, brief: join(dir, 'brief.txt'), product: 'codex', startupSeconds: 10, startupRetries: 2, ...spec } } }) }
  }
  const ports = () => fakePorts({ members: { windows: () => ['home'], start: (_s: string, plan: LaunchPlan) => void started.push(plan.name), stop: (_s: string, name: string, how: 'graceful' | 'kill') => void stopped.push(`${name}:${how}`), screen: () => null, press: () => undefined }, launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher } })
  const deps = (time: ReturnType<typeof clock>, lifeAfterStart: number | null): WatchdogDeps => {
    // The member shows a sign of life once it has been started `lifeAfterStart` times (null: never).
    return { startFailuresPath: p.startFailures, now: time.now, sleep: time.sleep, signals: () => (lifeAfterStart !== null && started.length >= lifeAfterStart ? [signal('CodexA', time.now())] : []) }
  }

  it('starts once and says so when the member shows a sign of life', () => {
    const text = memberCommand(config(), ports(), ['start', 'CodexA'], {}, deps(clock(), 1))
    assert.match(text, /CodexA: started in .*, shows a sign of life$/)
    assert.deepEqual([started, stopped], [['CodexA'], []])
  })

  it('closes a window that shows nothing and starts the member again, then says which try worked', () => {
    const text = memberCommand(config(), ports(), ['start', 'CodexA'], {}, deps(clock(), 2))
    assert.match(text, /CodexA: started in .* \(try 2\), shows a sign of life/)
    assert.deepEqual([started, stopped], [['CodexA', 'CodexA'], ['CodexA:kill']])
  })

  it('gives up after the retries, closes the window, and records the failure', () => {
    const text = memberCommand(config(), ports(), ['start', 'CodexA'], {}, deps(clock(), null))
    assert.match(text, /no sign of life after 3 starts of 10 seconds.*M-START-FAILED/)
    assert.deepEqual([started.length, stopped.length], [3, 3])
    assert.deepEqual(readStartFailures(p.startFailures).map((one) => [one.name, one.tries]), [['CodexA', 3]])
  })

  it('clears an earlier failure when a start works, and tries only once with no retries', () => {
    recordStartFailure(p.startFailures, { name: 'CodexA', at: NOW.toISOString(), tries: 3 })
    memberCommand(config(), ports(), ['start', 'CodexA'], {}, deps(clock(), 1))
    assert.deepEqual(readStartFailures(p.startFailures), [])
    started.length = 0
    memberCommand(config({ startupRetries: 0 }), ports(), ['start', 'CodexA'], {}, deps(clock(), null))
    assert.equal(started.length, 1)
  })

  it('does not wait with --no-wait, or for a member with no watchdog, or without the means to wait', () => {
    assert.match(memberCommand(config(), ports(), ['start', 'CodexA'], { 'no-wait': true }, deps(clock(), null)), /CodexA: started in [^,]*$/)
    started.length = 0
    assert.match(memberCommand(config({ product: 'claude-code', startupSeconds: undefined }), ports(), ['start', 'CodexA'], {}, deps(clock(), null)), /CodexA: started in [^,]*$/)
    assert.match(memberCommand(config(), ports(), ['start', 'CodexA'], {}), /CodexA: started in [^,]*$/)
    assert.deepEqual(readStartFailures(p.startFailures), [])
  })
})

describe('M-START-FAILED', () => {
  const failure = { name: 'CodexA', at: '2026-10-08T05:00:00.000Z', tries: 3 }
  const member = (name: string, state: MemberState['state']): MemberState => ({ name, state, since: null })

  it('is a medium finding for a member that was started and showed nothing, and goes when it shows life', () => {
    const [finding] = lintStartFailures([failure], [member('CodexA', 'unknown')])
    assert.deepEqual([finding?.rule, finding?.subject, finding?.severity], ['M-START-FAILED', 'CodexA', 'medium'])
    assert.match(finding?.message ?? '', /started 3 times and showed no sign of life/)
    assert.deepEqual(lintStartFailures([failure], [member('CodexA', 'idle')]), [])
  })

  it('is part of lintAll, the path that tells the TechLead, and can be cleared', () => {
    const ctx = { snapshot: null, members: [member('CodexA', 'unknown')], acks: [], config: base, now: NOW, startFailures: [failure] }
    assert.equal(lintAll(ctx).active.some((one) => one.rule === 'M-START-FAILED'), true)
    const path = join(mkdtempSync(join(tmpdir(), 'scrum-start-failed-')), 'f.json')
    recordStartFailure(path, failure)
    recordStartFailure(path, { ...failure, tries: 2 })
    assert.deepEqual(readStartFailures(path).map((one) => one.tries), [2])
    clearStartFailure(path, 'CodexA')
    assert.deepEqual(readStartFailures(path), [])
  })
})

describe('Codex\'s question about a directory', () => {
  const QUESTION = '> You are in /work/team\n\n  Do you trust the contents of this directory? Working with untrusted contents\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue\n'
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-trust-')))
    mkdirSync(join(p.dir, 'cache'), { recursive: true })
  })

  const config = (spec: Record<string, unknown>): Config => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-trust-dir-'))
    return { ...base, members: ['CodexA'], launch: parseLaunch({ tmuxSession: 'team', members: { CodexA: { dir, product: 'codex', startupSeconds: 10, startupRetries: 0, ...spec } } }) }
  }

  /** A window that shows the question until Enter is pressed, and then the member shows a sign of life. */
  function run(spec: Record<string, unknown>, screen: string = QUESTION) {
    const presses: string[] = []
    const time = clock()
    const ports = fakePorts({ members: { windows: () => ['home'], start: () => undefined, stop: () => undefined, screen: () => screen, press: (_s: string, _n: string, key: string) => void presses.push(key) }, launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher } })
    const deps: WatchdogDeps = { startFailuresPath: p.startFailures, now: time.now, sleep: time.sleep, signals: () => (presses.length > 0 ? [signal('CodexA', time.now())] : []) }
    return { text: memberCommand(config(spec), ports, ['start', 'CodexA'], {}, deps), presses }
  }

  it('is answered with Enter, once, for a Codex member that is set to have it answered', () => {
    const { text, presses } = run({ trustDirectory: true })
    assert.deepEqual(presses, ['Enter'])
    assert.match(text, /shows a sign of life/)
  })

  it('is left alone without trustDirectory, when the screen shows something else, and for a Claude Code member; the failure says what the window showed', () => {
    const left = run({})
    assert.deepEqual(left.presses, [])
    assert.match(left.text, /no sign of life.*Its window showed: .*Do you trust the contents of this directory\?/)
    assert.deepEqual(run({ trustDirectory: true }, 'a prompt about something else').presses, [])
    assert.deepEqual(run({ trustDirectory: true, product: 'claude-code' }).presses, [])
  })

  it('keeps what the window showed in the failure, and in the finding', () => {
    run({})
    const [failure] = readStartFailures(p.startFailures)
    assert.match(failure?.screen ?? '', /Do you trust the contents of this directory\?/)
    const [finding] = lintStartFailures(readStartFailures(p.startFailures), [{ name: 'CodexA', state: 'unknown', since: null }])
    assert.match(finding?.message ?? '', /Its window showed: .*Do you trust/)
  })

  it('reads trustDirectory as a switch', () => {
    assert.equal(parseLaunch({ tmuxSession: 't', members: { A: { trustDirectory: true } } })?.members.A?.trustDirectory, true)
    assert.equal(parseLaunch({ tmuxSession: 't', members: { A: { trustDirectory: 'yes' } } }), undefined)
  })

  it('summarizes a screen as its last few lines, short, without blanks', () => {
    assert.equal(screenSummary(null), null)
    assert.equal(screenSummary('  \n\n'), null)
    assert.equal(screenSummary('a\n\n b  c \nd', 2), 'b c | d')
    assert.equal(screenSummary(`${'x'.repeat(300)}`)?.length, 120)
  })
})

describe('stopping a member and what it leaves behind', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-exit-')))
  })
  const config = { ...base, members: ['CodexA'], launch: parseLaunch({ tmuxSession: 'team', members: {}, ignoreWindows: ['home'] }) }

  /** A member that is idle in a window; `after` says what happens in the window and the signals once it is asked to exit. */
  function run(after: { readonly windowCloses?: boolean; readonly endsSession?: boolean }) {
    const time = clock()
    const stops: string[] = []
    let asked = false
    const windows = () => (asked && after.windowCloses === true ? ['home'] : ['home', 'CodexA'])
    const idle = signal('CodexA', new Date(NOW.getTime() - 60_000))
    const ports = fakePorts({ members: { windows, start: () => undefined, stop: (_s: string, name: string, how: 'graceful' | 'kill') => { stops.push(`${name}:${how}`); if (how === 'graceful') asked = true }, screen: () => null, press: () => undefined }, sessions: { find: () => ({ name: null, pid: null }), signals: () => [idle] } })
    const signals = () => (asked && after.endsSession === true ? [signal('CodexA', time.now(), { state: 'ended' })] : [idle])
    const text = memberCommand(config, ports, ['stop', 'CodexA'], {}, { startFailuresPath: p.startFailures, now: time.now, sleep: time.sleep, signals })
    return { text, stops }
  }

  it('says it exited when the window goes away by itself, and closes nothing', () => {
    const { text, stops } = run({ windowCloses: true })
    assert.match(text, /CodexA: exited$/)
    assert.deepEqual(stops, ['CodexA:graceful'])
  })

  it('closes the window that is left over once the session has ended (Codex shows its list of sessions after one ends)', () => {
    const { text, stops } = run({ endsSession: true })
    assert.match(text, /CodexA: exited; the window Codex left open is closed/)
    assert.deepEqual(stops, ['CodexA:graceful', 'CodexA:kill'])
  })

  it('leaves a member that has not ended in 15 seconds running, and says how to close it', () => {
    const { text, stops } = run({})
    assert.match(text, /CodexA: asked to exit, and still runs after 15 seconds \(--force closes its window\)/)
    assert.deepEqual(stops, ['CodexA:graceful'])
  })
})
