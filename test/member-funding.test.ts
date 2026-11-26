import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agencyFundingLister, agencyFundingPicker } from '../src/adapters/agency/funding.ts'
import { claudeCodeLauncher } from '../src/adapters/claude-code/launch.ts'
import { claudeHooksInstalled } from '../src/adapters/claude-code/hooks-check.ts'
import { codexLauncher } from '../src/adapters/codex/launch.ts'
import type { Config } from '../src/config.ts'
import { lintAll } from '../src/findings/lint.ts'
import { memberCommand, type WatchdogDeps } from '../src/members/command.ts'
import { parseLaunch } from '../src/members/config.ts'
import { readFundingDirs, refreshFundingDirs } from '../src/members/funding-dirs.ts'
import { readMemberSources } from '../src/members/funding.ts'
import type { FundingPick, FundingTool, LaunchPlan } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import { settingsTargets } from '../src/wiring.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, NOW } from './helpers.ts'

const FAKE = fileURLToPath(new URL('./fixtures/funding/fake-agency.mjs', import.meta.url))

/** A copy of the fake `agency` that only the user can write. */
function program(mode = 0o755): string {
  const path = join(mkdtempSync(join(tmpdir(), 'scrum-funding-')), 'agency')
  copyFileSync(FAKE, path)
  chmodSync(path, mode)
  return path
}

function answer(pick: string, exit = 0, extra: Record<string, string> = {}): void {
  process.env.FAKE_PICK = pick
  process.env.FAKE_EXIT = String(exit)
  for (const key of ['FAKE_STDERR', 'FAKE_ARGS', 'FAKE_HANG']) delete process.env[key]
  Object.assign(process.env, extra)
}

const OK = JSON.stringify({ state: 'ok', source: 'personal-2', tool: 'claude', env: { CLAUDE_CONFIG_DIR: '/accounts/personal-2' }, reason: 'personal-1 is at 83% of its 7-day window (threshold 80)' })

describe('agencyFundingPicker: what the node answers', () => {
  it('asks `pick --tool <tool> --dir <dir>` after the program\'s own arguments, and reads the answer', () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), 'scrum-funding-args-')), 'args')
    answer(OK, 0, { FAKE_ARGS: argsFile })
    const pick = agencyFundingPicker({ command: [program(), 'funding'], dir: '/data' })('claude')
    assert.deepEqual(pick, { state: 'ok', source: 'personal-2', env: { CLAUDE_CONFIG_DIR: '/accounts/personal-2' }, reason: 'personal-1 is at 83% of its 7-day window (threshold 80)' })
    assert.equal(readFileSync(argsFile, 'utf8').trim().split('\n')[0], JSON.stringify(['funding', 'pick', '--tool', 'claude', '--dir', '/data']))
  })

  it('takes none (exit 3) as an answer, and the other states', () => {
    answer(JSON.stringify({ state: 'none', env: {}, reason: 'every source is at its limit' }), 3)
    assert.equal(agencyFundingPicker({ command: [program()] })('codex').state, 'none')
    answer(JSON.stringify({ state: 'overThreshold', source: 'a', env: {} }))
    assert.equal(agencyFundingPicker({ command: [program()] })('claude').state, 'overThreshold')
  })

  it('throws, with the program\'s words, when it fails, is silent, or answers something else', () => {
    const pick = (): FundingPick => agencyFundingPicker({ command: [program()] })('claude')
    answer('', 1, { FAKE_STDERR: 'no usage file' })
    assert.throws(pick, /failed \(exit 1\): no usage file/)
    answer('not json')
    assert.throws(pick, /did not answer with JSON: not json/)
    answer(JSON.stringify({ state: 'maybe', env: {} }))
    assert.throws(pick, /its state is not one of/)
    answer(JSON.stringify({ state: 'ok', env: {} }), 3)
    assert.throws(pick, /exited 3 but did not answer none/)
  })

  it('refuses an environment that sets anything but where a login lives', () => {
    for (const env of [{ PATH: '/tmp/evil' }, { NODE_OPTIONS: '--require x' }, { CLAUDE_CONFIG_DIR: 5 }, { CLAUDE_CONFIG_DIR: '' }]) {
      answer(JSON.stringify({ state: 'ok', source: 's', env }))
      assert.throws(() => agencyFundingPicker({ command: [program()] })('claude'), /only CLAUDE_CONFIG_DIR and CODEX_HOME may be set/, JSON.stringify(env))
    }
  })

  it('refuses a program that others can write, and one that does not exist', () => {
    answer(OK)
    assert.throws(() => agencyFundingPicker({ command: [program(0o777)] })('claude'), /node program can be written by the group or by others/)
    assert.throws(() => agencyFundingPicker({ command: ['/no/such/agency'] })('claude'), /node program does not exist/)
  })

  it('stops waiting for a program that hangs', { timeout: 40_000 }, () => {
    answer(OK, 0, { FAKE_HANG: '1' })
    assert.throws(() => agencyFundingPicker({ command: [program()] })('claude'), /did not answer/)
  })
})

describe('the funding setting', () => {
  const launch = (funding: unknown) => parseLaunch({ tmuxSession: 't', members: {}, funding })

  it('is a program and its first arguments, and the node\'s data directory', () => {
    assert.deepEqual(launch({ command: ['/usr/local/bin/agency', 'funding'], dir: '~/agency-data' })?.funding, { command: ['/usr/local/bin/agency', 'funding'], dir: '~/agency-data' })
    assert.equal(launch(undefined)?.funding, undefined)
  })

  it('takes autoMove as a switch, off unless set', () => {
    assert.equal(launch({ command: ['/a'], autoMove: true })?.funding?.autoMove, true)
    assert.equal(launch({ command: ['/a'] })?.funding?.autoMove, undefined)
    assert.equal(launch({ command: ['/a'], autoMove: 'yes' }), undefined)
  })

  it('is refused when the program is not an absolute path, the list is empty, or something else is in it', () => {
    for (const bad of [{ command: ['agency'] }, { command: [] }, { command: ['/a', ''] }, { command: '/a' }, { command: ['/a'], dir: 'relative' }, { command: ['/a'], extra: 1 }, 'agency']) {
      assert.equal(launch(bad), undefined, JSON.stringify(bad))
    }
  })
})

describe('a member starts on the account the node picked', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-funding-state-')))
  })

  const config = (members: Record<string, Record<string, unknown>>): Config => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-funding-dir-'))
    const specs = Object.fromEntries(Object.entries(members).map(([name, spec]) => [name, { dir, ...spec }]))
    return { ...base, members: Object.keys(members), launch: parseLaunch({ tmuxSession: 'team', funding: { command: ['/usr/local/bin/agency', 'funding'] }, members: specs }) }
  }

  function run(members: Record<string, Record<string, unknown>>, picker: ((tool: FundingTool) => FundingPick) | null, args: readonly string[], options: { readonly hasHooks?: boolean; readonly flags?: Record<string, boolean> } = {}) {
    const started: LaunchPlan[] = []
    const asked: FundingTool[] = []
    const ports = fakePorts({
      members: { windows: () => ['home'], start: (_s: string, plan: LaunchPlan) => void started.push(plan), stop: () => undefined, screen: () => null, press: () => undefined },
      funding: picker === null ? null : (tool: FundingTool) => (asked.push(tool), picker(tool)),
      hasHooksIn: () => options.hasHooks ?? true,
      launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher },
    })
    const deps: WatchdogDeps = { startFailuresPath: p.startFailures, memberSourcesPath: p.memberSources, now: () => NOW, sleep: () => undefined, signals: () => [] }
    const text = memberCommand(config(members), ports, args, { 'no-wait': true, ...options.flags }, deps)
    return { text, started, asked, ports }
  }

  const picked = (extra: Partial<FundingPick> = {}) => (): FundingPick => ({ state: 'ok', source: 'personal-2', env: { CLAUDE_CONFIG_DIR: '/accounts/personal-2' }, reason: 'personal-1 is at 83%', ...extra })

  it('sets the environment the node named, and says which source it is on', () => {
    const { text, started, asked } = run({ SWE1: {} }, picked(), ['start', 'SWE1'])
    assert.deepEqual(asked, ['claude'])
    assert.equal(started[0]?.env.CLAUDE_CONFIG_DIR, '/accounts/personal-2')
    assert.match(text, /SWE1: started in .*\nSWE1: on source personal-2 \(under its threshold: personal-1 is at 83%\)/)
  })

  it('asks for a Codex member with the tool codex, and sets CODEX_HOME', () => {
    const { started, asked } = run({ CodexA: { product: 'codex' } }, picked({ env: { CODEX_HOME: '/accounts/codex-2' } }), ['start', 'CodexA'])
    assert.deepEqual(asked, ['codex'])
    assert.equal(started[0]?.env.CODEX_HOME, '/accounts/codex-2')
  })

  it('shows the pick in a dry run, starts nothing, and records nothing', () => {
    const ports = run({ SWE1: {} }, picked(), ['start', 'SWE1'], { flags: { 'dry-run': true } })
    assert.equal(ports.started.length, 0)
    assert.match(ports.text, /CLAUDE_CONFIG_DIR=\/accounts\/personal-2/)
    assert.deepEqual(readMemberSources(p.memberSources), [])
  })

  it('leaves a member with its own configDir alone, and asks nothing for it', () => {
    const { started, asked } = run({ SWE1: { configDir: '/accounts/own' } }, picked(), ['start', 'SWE1'])
    assert.deepEqual(asked, [])
    assert.equal(started[0]?.env.CLAUDE_CONFIG_DIR, '/accounts/own')
  })

  it('starts on the member\'s own settings, and says so, when the node cannot be asked', () => {
    const { text, started } = run({ SWE1: {} }, () => { throw new Error('agency failed (exit 1): no usage file') }, ['start', 'SWE1'])
    assert.equal(started.length, 1)
    assert.equal(started[0]?.env.CLAUDE_CONFIG_DIR, undefined)
    assert.match(text, /the account could not be picked \(agency failed \(exit 1\): no usage file\); it starts on its own settings/)
  })

  it('does nothing different without a funding command', () => {
    const { started, asked, text } = run({ SWE1: {} }, null, ['start', 'SWE1'])
    assert.deepEqual(asked, [])
    assert.equal(started.length, 1)
    assert.doesNotMatch(text, /source/)
  })

  it('does not start a member when every source is at its limit, and keeps why', () => {
    const { text, started } = run({ SWE1: {} }, () => ({ state: 'none', env: {}, reason: 'personal-1 and personal-2 are at 100% of their 5-hour windows' }), ['start', 'SWE1'])
    assert.equal(started.length, 0)
    assert.match(text, /SWE1: not started: personal-1 and personal-2 are at 100%/)
    assert.equal(readMemberSources(p.memberSources)[0]?.state, 'refused')
  })

  it('does not start a Claude Code member under a login that has no harness hooks, and names the command that adds them', () => {
    const { text, started } = run({ SWE1: {} }, picked(), ['start', 'SWE1'], { hasHooks: false })
    assert.equal(started.length, 0)
    assert.match(text, /SWE1: not started: source personal-2 \(\/accounts\/personal-2\) has no harness hooks.*unguarded and unwatched.*`scrum install --dir \/accounts\/personal-2`/)
  })

  it('does not look for hooks for a Codex member (its hooks are passed at the start)', () => {
    const { started } = run({ CodexA: { product: 'codex' } }, picked({ env: { CODEX_HOME: '/accounts/codex-2' } }), ['start', 'CodexA'], { hasHooks: false })
    assert.equal(started.length, 1)
  })

  it('shows the source of a member that runs, and the refusal of one that does not, in the list and as a finding', () => {
    run({ SWE1: {}, SWE2: {} }, picked(), ['start', 'SWE1'])
    run({ SWE1: {}, SWE2: {} }, picked(), ['start', 'SWE2'], { hasHooks: false })
    const sources = readMemberSources(p.memberSources)
    assert.deepEqual(sources.map((one) => [one.name, one.state]), [['SWE1', 'ok'], ['SWE2', 'refused']])
    const findings = lintAll({ ...lintContext(), memberSources: sources }).active.filter((finding) => finding.rule === 'M-SOURCE-REFUSED')
    assert.deepEqual(findings.map((finding) => finding.subject), ['SWE2'])
    assert.match(findings[0]?.message ?? '', /SWE2 was not started .*has no harness hooks/)
    const list = memberCommand(config({ SWE1: {}, SWE2: {} }), fakePorts({ members: { windows: () => ['home', 'SWE1'], start: () => undefined, stop: () => undefined, screen: () => null, press: () => undefined } }), ['list'], {}, { startFailuresPath: p.startFailures, memberSourcesPath: p.memberSources, now: () => NOW, sleep: () => undefined, signals: () => [] })
    assert.match(list, /SWE1 .*running.*\[source personal-2\]/)
    assert.match(list, /SWE2 .*not running.*\[start refused: source personal-2 .*has no harness hooks/)
  })

  it('forgets a refusal once a start is not refused', () => {
    run({ SWE1: {} }, () => ({ state: 'none', env: {}, reason: 'limits' }), ['start', 'SWE1'])
    run({ SWE1: {} }, null, ['start', 'SWE1'])
    assert.deepEqual(readMemberSources(p.memberSources), [])
  })
})

function lintContext() {
  return { snapshot: { items: [], openIssues: [] }, members: [], acks: [], config: base, now: NOW } as unknown as Parameters<typeof lintAll>[0]
}

const LIVE = JSON.stringify({ state: 'ok', source: 'personal-1', tool: 'claude', env: {}, sevenDayThreshold: 80, reason: 'personal-1 is at 72% of its 7-day window (threshold 80)' })

describe('the default login', () => {
  it('is an empty env, which changes nothing, and the answer\'s other fields are not an error', () => {
    answer(LIVE)
    const pick = agencyFundingPicker({ command: [program()] })('claude')
    assert.deepEqual(pick.env, {})
    assert.equal(pick.source, 'personal-1')
  })

  it('leaves a member\'s environment as it was, and is not recorded as a login directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-funding-default-'))
    const ports = fakePorts({ funding: () => ({ state: 'ok', source: 'default', env: {} }), members: { windows: () => ['home'], start: () => undefined, stop: () => undefined, screen: () => null, press: () => undefined }, launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher } })
    const launch = parseLaunch({ tmuxSession: 'team', funding: { command: ['/usr/local/bin/agency'] }, members: { SWE1: { dir } } })
    const text = memberCommand({ ...base, members: ['SWE1'], launch }, ports, ['start', 'SWE1'], { 'dry-run': true })
    assert.doesNotMatch(text, /CLAUDE_CONFIG_DIR/)
    assert.match(text, /on source default/)
  })
})

describe('agencyFundingLister: the node\'s funding sources', () => {
  it('reads the list the node answers', () => {
    answer(JSON.stringify([{ source: 'one', tool: 'claude', env: {}, sevenDayThreshold: 80 }, { source: 'two', tool: 'claude', env: { CLAUDE_CONFIG_DIR: '/accounts/two' } }, { source: 'cx', tool: 'codex', env: { CODEX_HOME: '/accounts/cx' } }]))
    assert.deepEqual(agencyFundingLister({ command: [program()] })().map((one) => [one.source, one.tool, one.env]), [['one', 'claude', {}], ['two', 'claude', { CLAUDE_CONFIG_DIR: '/accounts/two' }], ['cx', 'codex', { CODEX_HOME: '/accounts/cx' }]])
  })

  it('reads the list the live node answers: three flags on every source, and a source on the default login with an empty env', () => {
    const flags = { sevenDayThreshold: 80, overThreshold: false, blocked: false, unknown: false }
    answer(JSON.stringify([{ source: 'personal-1', tool: 'claude', env: {}, ...flags }, { source: 'personal-2', tool: 'claude', env: { CLAUDE_CONFIG_DIR: '/accounts/two' }, ...flags, unknown: true }, { source: 'codex-1', tool: 'codex', env: {}, ...flags }]))
    const [one, two, three] = agencyFundingLister({ command: [program()] })()
    assert.deepEqual([one?.overThreshold, one?.blocked, one?.unknown, two?.unknown, three?.tool], [false, false, false, true, 'codex'])
  })

  it('reads whether a source is past its threshold or blocked, when the node says', () => {
    answer(JSON.stringify([{ source: 'one', tool: 'claude', env: {}, overThreshold: true, blocked: false }, { source: 'two', tool: 'claude', env: {}, overThreshold: 'yes' }]))
    const [one, two] = agencyFundingLister({ command: [program()] })()
    assert.deepEqual([one?.overThreshold, one?.blocked, two?.overThreshold, two?.blocked], [true, false, undefined, undefined])
  })

  it('throws for something that is not a list, a source without a name or a known tool, or an env that sets anything else', () => {
    for (const bad of ['{}', '[{"tool":"claude","env":{}}]', '[{"source":"a","tool":"gemini","env":{}}]', '[{"source":"a","tool":"claude","env":{"PATH":"/x"}}]']) {
      answer(bad)
      assert.throws(() => agencyFundingLister({ command: [program()] })(), /did not answer a list|no name|may be set/, bad)
    }
  })
})

describe('the login directories of the funding sources are kept', () => {
  const file = (): string => join(mkdtempSync(join(tmpdir(), 'scrum-funding-dirs-')), 'cache', 'funding-dirs.json')
  const lister = (sources: readonly { source: string; tool: 'claude' | 'codex'; env: Record<string, string> }[]) => fakePorts({ fundingSources: () => sources })

  it('writes each tool\'s directories (the default login has none) and reads them back', () => {
    const path = file()
    const ports = lister([{ source: 'one', tool: 'claude', env: {} }, { source: 'two', tool: 'claude', env: { CLAUDE_CONFIG_DIR: '/accounts/two' } }, { source: 'cx', tool: 'codex', env: { CODEX_HOME: '/accounts/cx' } }])
    assert.equal(refreshFundingDirs(ports, path, NOW), null)
    assert.deepEqual(readFundingDirs(path), { at: NOW.toISOString(), claude: ['/accounts/two'], codex: ['/accounts/cx'] })
  })

  it('keeps what it had, and says why, when the node cannot be asked', () => {
    const path = file()
    refreshFundingDirs(lister([{ source: 'two', tool: 'claude', env: { CLAUDE_CONFIG_DIR: '/accounts/two' } }]), path, NOW)
    const down = fakePorts({ fundingSources: () => { throw new Error('agency failed (exit 1)') } })
    assert.match(refreshFundingDirs(down, path, NOW) ?? '', /agency failed/)
    assert.deepEqual(readFundingDirs(path).claude, ['/accounts/two'])
  })

  it('is nothing without a funding command, and an empty record before the first read', () => {
    assert.equal(refreshFundingDirs(fakePorts(), file(), NOW), null)
    assert.deepEqual(readFundingDirs(file()), { at: '', claude: [], codex: [] })
  })
})

describe('the hook check follows symlinks (a second login that shares the first one\'s settings)', () => {
  const settings = (hooks: unknown) => JSON.stringify({ hooks })
  const ours = { SessionStart: [{ hooks: [{ type: 'command', command: '/x/scrum-harness/bin/scrum hook SessionStart' }] }] }

  it('finds the hooks through a symlinked settings.json, and not in a login that has none', () => {
    const root = mkdtempSync(join(tmpdir(), 'scrum-funding-links-'))
    const first = join(root, 'first')
    const second = join(root, 'second')
    const bare = join(root, 'bare')
    for (const dir of [first, second, bare]) mkdirSync(dir)
    writeFileSync(join(first, 'settings.json'), settings(ours))
    symlinkSync(join(first, 'settings.json'), join(second, 'settings.json'))
    writeFileSync(join(bare, 'settings.json'), settings({ Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] }))
    assert.equal(claudeHooksInstalled(second), true)
    assert.equal(claudeHooksInstalled(bare), false)
    assert.equal(claudeHooksInstalled(join(root, 'missing')), false)
  })

  it('finds nothing through a symlink that points nowhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'scrum-funding-links-'))
    symlinkSync(join(root, 'gone.json'), join(root, 'settings.json'))
    assert.equal(claudeHooksInstalled(root), false)
  })
})

describe('the funding sources\' directories join the ones the harness reads', () => {
  it('are in `scrum install --all`, after the configured ones, and only when there is a funding command', () => {
    const state = mkdtempSync(join(tmpdir(), 'scrum-funding-wiring-'))
    const before = process.env.SCRUM_STATE_DIR
    process.env.SCRUM_STATE_DIR = state
    try {
      mkdirSync(join(state, 'cache'))
      writeFileSync(join(state, 'cache', 'funding-dirs.json'), JSON.stringify({ at: NOW.toISOString(), claude: ['/accounts/two'], codex: [] }))
      const withFunding: Config = { ...base, claudeConfigDirs: ['/accounts/one'], launch: parseLaunch({ tmuxSession: 't', members: {}, funding: { command: ['/usr/local/bin/agency'] } }) }
      assert.deepEqual(settingsTargets({ all: true }, withFunding), ['/accounts/one/settings.json', '/accounts/two/settings.json'])
      assert.deepEqual(settingsTargets({ all: true }, { ...base, claudeConfigDirs: ['/accounts/one'] }), ['/accounts/one/settings.json'])
    } finally {
      if (before === undefined) delete process.env.SCRUM_STATE_DIR
      else process.env.SCRUM_STATE_DIR = before
    }
  })
})

describe('the Claude Code launcher continues a session', () => {
  it('puts --resume <session> after the name, and the note as the first message', () => {
    const argv = claudeCodeLauncher({ name: 'SWE1', spec: { model: 'm' }, brief: 'carry on', resume: 'sess-1' })
    assert.deepEqual(argv, ['claude', '-n', 'SWE1', '--resume', 'sess-1', '--model', 'm', 'carry on'])
    assert.deepEqual(claudeCodeLauncher({ name: 'SWE1', spec: {}, brief: '' }), ['claude', '-n', 'SWE1'])
  })
})
