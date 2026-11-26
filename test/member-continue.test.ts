import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tmuxHost } from '../src/adapters/tmux/host.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import type { Config } from '../src/config.ts'
import { memberCommand } from '../src/members/command.ts'
import { parseLaunch } from '../src/members/config.ts'
import { continueIdle, isStillTyped } from '../src/members/continue.ts'
import { readContinued } from '../src/members/continued.ts'
import { lintContinued } from '../src/members/rules.ts'
import type { WatchdogDeps } from '../src/members/lifecycle.ts'
import { paths, writeJson, type Paths } from '../src/store.ts'
import type { SessionSignal } from '../src/team/types.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, issue, NOW, snapshot } from './helpers.ts'

const TEXT = 'Continue your current item until you open or update a PR. If you have no item, say so and end the turn.'
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()

const signal = (name: string, state: SessionSignal['state'], sinceMinutesAgo: number): SessionSignal => ({ sessionId: `s-${name}`, name, state, since: minutesAgo(sinceMinutesAgo), updatedAt: minutesAgo(sinceMinutesAgo), isAlive: true, nameSince: null })

describe('the continuation setting of a member', () => {
  const parse = (spec: object) => parseLaunch({ tmuxSession: 't', members: { CodexA: { product: 'codex', ...spec } } })?.members.CodexA

  it('is a one-line text with the minutes after which it is sent (10 by default)', () => {
    assert.deepEqual(parse({ continuation: { text: TEXT } })?.continuation, { text: TEXT, afterMinutes: 10 })
    assert.deepEqual(parse({ continuation: { text: ` ${TEXT} `, afterMinutes: 25 } })?.continuation, { text: TEXT, afterMinutes: 25 })
  })

  it('is refused for a member that is not a Codex member, and for a value of the wrong shape', () => {
    assert.equal(parseLaunch({ tmuxSession: 't', members: { ClaudeA: { continuation: { text: TEXT } } } }), undefined)
    assert.equal(parseLaunch({ tmuxSession: 't', members: { ClaudeA: { product: 'claude-code', continuation: { text: TEXT } } } }), undefined)
    for (const bad of [{}, { text: '' }, { text: 'two\nlines' }, { text: 'x'.repeat(1001) }, { text: TEXT, afterMinutes: 0 }, { text: TEXT, afterMinutes: 1441 }, { text: TEXT, afterMinutes: 1.5 }, { text: TEXT, tell: 'agency:Lead' }, { text: TEXT, extra: 1 }]) {
      assert.equal(parse({ continuation: bad }), undefined, JSON.stringify(bad))
    }
  })
})

describe('whether the line is still in the input box', () => {
  const screen = (input: string): string => ['  Working on the rollout.', '  continuing...', '', `\u203A ${input}`, '', '  gpt-x  100% context left'].join('\n')

  it('is true while one of the last lines starts with the prompt mark and the beginning of the text, and false once it has left', () => {
    assert.equal(isStillTyped(screen(TEXT), TEXT), true)
    assert.equal(isStillTyped(screen('Find and fix a bug in @filename'), TEXT), false)
    assert.equal(isStillTyped(`${TEXT}\n${screen('')}`, TEXT), false)
    assert.equal(isStillTyped(null, TEXT), false)
  })
})

describe('telling a Codex member to go on', () => {
  let p: Paths
  let said: { session: string; name: string; text: string }[]
  let sleeps: number[]

  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-continue-')))
    said = []
    sleeps = []
  })

  const config = (spec: Record<string, unknown> = {}): Config => ({
    ...base,
    members: ['SWE1', 'CodexA'],
    launch: parseLaunch({ tmuxSession: 'team', members: { SWE1: {}, CodexA: { product: 'codex', continuation: { text: TEXT, afterMinutes: 10, ...spec } } } }),
  })

  type World = { readonly signals?: readonly SessionSignal[]; readonly screen?: string; readonly windows?: readonly string[]; readonly failsFor?: string; readonly now?: Date }
  function run(world: World = {}, spec: Record<string, unknown> = {}, isDryRun = false, at: Date = world.now ?? NOW) {
    const signals = world.signals ?? [signal('CodexA', 'idle', 12), signal('SWE1', 'idle', 60)]
    const ports = fakePorts({
      members: {
        windows: () => world.windows ?? ['home', 'SWE1', 'CodexA'],
        start: () => undefined,
        stop: () => undefined,
        screen: () => world.screen ?? '  continuing...\n\n\u203A Find and fix a bug in @filename\n',
        say: (session: string, name: string, text: string) => {
          if (name === world.failsFor) throw new Error(`there is no window named ${name} in the tmux session ${session}`)
          said.push({ session, name, text })
        },
        press: () => undefined,
      },
    })
    const deps: WatchdogDeps = { startFailuresPath: p.startFailures, paths: p, now: () => at, sleep: (ms: number) => void sleeps.push(ms), signals: () => signals }
    return { lines: continueIdle(config(spec), ports, deps, isDryRun), ports, deps }
  }

  it('types the text into the window of a Codex member that has been idle for its minutes, looks that it left the input box, and says so with the case', () => {
    const { lines } = run()
    assert.deepEqual(said, [{ session: 'team', name: 'CodexA', text: TEXT }])
    assert.deepEqual(sleeps, [5000])
    assert.deepEqual(lines, ['CodexA was idle at its prompt for 12 minutes (no In Progress item); the harness typed its continuation text'])
  })

  it('names the issues it had In Progress when it has some', () => {
    saveSnapshot(p, snapshot([issue(7, { status: base.statuses.doing, assignee: 'CodexA' }), issue(8, { status: base.statuses.doing, assignee: 'SWE1' }), issue(9, { status: base.statuses.next, assignee: 'CodexA' })]))
    assert.match(run().lines.join('\n'), /\(app#7 In Progress\)/)
  })

  it('says the line is still in the input box when it did not leave', () => {
    assert.match(run({ screen: `  continuing...\n\n\u203A ${TEXT}\n` }).lines.join('\n'), /the line is still in its input box: it was not submitted/)
  })

  it('records the stretch and the event, and does not tell the same stretch twice, but a later stretch of idleness again', () => {
    run()
    const events = readFileSync(p.events, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.deepEqual([events[0]?.type, events[0]?.name, events[0]?.minutes, events[0]?.isSubmitted, events[0]?.items], ['continued', 'CodexA', 12, true, undefined])
    assert.equal(run().lines.length, 0)
    assert.equal(said.length, 1)
    // it worked, then went idle again: a new stretch, 11 minutes old
    assert.equal(run({ signals: [signal('CodexA', 'idle', 11)] }).lines.length, 1)
    assert.equal(said.length, 2)
  })

  it('leaves a member that is busy, that has not been idle long enough, or that has no window', () => {
    assert.deepEqual(run({ signals: [signal('CodexA', 'busy', 12)] }).lines, [])
    assert.deepEqual(run({ signals: [signal('CodexA', 'waiting', 12)] }).lines, [])
    assert.deepEqual(run({ signals: [signal('CodexA', 'idle', 9)] }).lines, [])
    assert.deepEqual(run({ windows: ['home', 'SWE1'] }).lines, [])
    assert.deepEqual(run({ signals: [] }).lines, [])
    assert.deepEqual(said, [])
  })

  it('waits for the member\'s own number of minutes', () => {
    assert.equal(run({ signals: [signal('CodexA', 'idle', 24)] }, { afterMinutes: 25 }).lines.length, 0)
    assert.equal(run({ signals: [signal('CodexA', 'idle', 26)] }, { afterMinutes: 25 }).lines.length, 1)
  })

  it('does not tell while an acknowledgement of its idleness is in force, and does again once it has run out', () => {
    const ack = (until: string) => writeJson(p.acks, [{ rule: 'T-IDLE', subject: 'CodexA', until, reason: 'slot 12:00', at: minutesAgo(60) }])
    ack(new Date(NOW.getTime() + 30 * 60_000).toISOString())
    assert.deepEqual(run().lines, [])
    ack(minutesAgo(1))
    assert.equal(run().lines.length, 1)
  })

  it('never touches a Claude Code member, however long it has been idle', () => {
    run({ signals: [signal('SWE1', 'idle', 600), signal('CodexA', 'busy', 1)] })
    assert.deepEqual(said, [])
  })

  it('types into the window of the member itself and nowhere else', () => {
    run({ signals: [signal('CodexA', 'idle', 30), signal('SWE1', 'idle', 600)] })
    assert.deepEqual(said.map((one) => [one.session, one.name]), [['team', 'CodexA']])
  })

  it('does not record a try that failed, so the next call tries again', () => {
    const failed = run({ failsFor: 'CodexA' })
    assert.match(failed.lines.join(''), /CodexA: could not be told to go on: there is no window named CodexA/)
    assert.equal(run().lines.length, 1)
  })

  it('types nothing with --dry-run, and records nothing', () => {
    const { lines } = run({}, {}, true)
    assert.deepEqual(lines, ['CodexA: would be told to go on (idle 12 minutes; no In Progress item)'])
    assert.deepEqual(said, [])
    assert.equal(run().lines.length, 1)
  })

  it('is the command `scrum member continue`', () => {
    const ports = fakePorts({ members: { windows: () => ['CodexA'], start: () => undefined, stop: () => undefined, screen: () => null, say: (session: string, name: string, text: string) => void said.push({ session, name, text }), press: () => undefined } })
    const deps: WatchdogDeps = { startFailuresPath: p.startFailures, paths: p, now: () => NOW, sleep: () => undefined, signals: () => [signal('CodexA', 'idle', 15)] }
    assert.match(memberCommand(config(), ports, ['continue'], {}, deps), /CodexA was idle at its prompt for 15 minutes/)
    assert.match(memberCommand(config(), ports, ['continue'], {}, deps), /no Codex member needs to be told to go on/)
  })
})

describe('the finding that tells the TechLead', () => {
  const record = { idleSince: minutesAgo(40), at: minutesAgo(5), minutes: 35, items: [] as readonly string[], isSubmitted: true }

  it('is medium, says which case it was, is one finding for the idle stretch, and goes away after an hour', () => {
    const [none] = lintContinued({ CodexA: record }, NOW)
    assert.deepEqual([none?.rule, none?.subject, none?.severity, none?.key], ['M-CONTINUED', 'CodexA', 'medium', `M-CONTINUED:CodexA:${record.idleSince}`])
    assert.equal(none?.message, 'CodexA was idle at its prompt for 35 minutes (no In Progress item); the harness typed its continuation text')
    const [doing] = lintContinued({ CodexA: { ...record, items: ['app#7', 'app#9'], isSubmitted: false } }, NOW)
    assert.match(doing?.message ?? '', /\(app#7, app#9 In Progress\).*still in its input box: it was not submitted/)
    assert.deepEqual(lintContinued({ CodexA: { ...record, at: minutesAgo(61) } }, NOW), [])
  })

  it('is made from the record that telling a member keeps', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-continue-finding-')))
    const ports = fakePorts({ members: { windows: () => ['CodexA'], start: () => undefined, stop: () => undefined, screen: () => null, say: () => undefined, press: () => undefined } })
    const deps: WatchdogDeps = { startFailuresPath: p.startFailures, paths: p, now: () => NOW, sleep: () => undefined, signals: () => [signal('CodexA', 'idle', 15)] }
    const launch = parseLaunch({ tmuxSession: 'team', members: { CodexA: { product: 'codex', continuation: { text: TEXT } } } })
    continueIdle({ ...base, members: ['CodexA'], launch }, ports, deps)
    const [finding] = lintContinued(readContinued(p.memberContinued), NOW)
    assert.match(finding?.message ?? '', /^CodexA was idle at its prompt for 15 minutes \(no In Progress item\)/)
  })
})

describe('typing a line into a tmux window', () => {
  it('sends the text with -l, waits a second, then Enter, to the window it names by its id', () => {
    const calls: string[][] = []
    const sleeps: number[] = []
    const host = tmuxHost((command, args) => {
      calls.push([command, ...args])
      return { status: 0, stdout: args[0] === 'list-windows' ? '@1 home\n@2 CodexA\n' : '', stderr: '' }
    }, (ms) => void sleeps.push(ms))
    host.say('team', 'CodexA', 'go on -- with "quotes" and a trailing Enter')
    assert.deepEqual(calls.slice(1), [['tmux', 'send-keys', '-t', '@2', '-l', 'go on -- with "quotes" and a trailing Enter'], ['tmux', 'send-keys', '-t', '@2', 'Enter']])
    assert.deepEqual(sleeps, [1000])
  })

  it('throws when the window is not there', () => {
    const host = tmuxHost(() => ({ status: 0, stdout: '@1 home\n', stderr: '' }), () => undefined)
    assert.throws(() => host.say('team', 'CodexA', 'x'), /there is no window named CodexA/)
  })
})
