import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agencyBudgetReader } from '../src/adapters/agency/budget.ts'
import { claudeCodeLauncher } from '../src/adapters/claude-code/launch.ts'
import { codexLauncher } from '../src/adapters/codex/launch.ts'
import { parseBudget } from '../src/budget/config.ts'
import { currentBudget, describeBudget, nextWeek, readBudgetRecord, refreshBudget } from '../src/budget/record.ts'
import { lintBudget } from '../src/budget/rules.ts'
import type { Config } from '../src/config.ts'
import { lintAll } from '../src/findings/lint.ts'
import { memberCommand, type WatchdogDeps } from '../src/members/command.ts'
import { parseLaunch } from '../src/members/config.ts'
import type { BudgetStatus, LaunchPlan } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, NOW } from './helpers.ts'

const FAKE = fileURLToPath(new URL('./fixtures/funding/fake-agency.mjs', import.meta.url))

function program(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'scrum-budget-')), 'agency')
  copyFileSync(FAKE, path)
  chmodSync(path, 0o755)
  return path
}

function answer(pick: string, extra: Record<string, string> = {}): void {
  process.env.FAKE_PICK = pick
  process.env.FAKE_EXIT = '0'
  for (const key of ['FAKE_STDERR', 'FAKE_ARGS', 'FAKE_HANG']) delete process.env[key]
  Object.assign(process.env, extra)
}

const status = (state: 'ok' | 'warning' | 'over', extra: Partial<BudgetStatus> = {}): BudgetStatus => ({
  weekStart: '2026-11-23',
  team: { capUsd: 200, spentUsd: state === 'over' ? 210 : state === 'warning' ? 163.4 : 20, state },
  org: { capUsd: 500, spentUsd: 311, state: 'ok' },
  ...extra,
})

describe('launch.budget', () => {
  const valid = { command: ['/usr/local/bin/agency', 'budget'], org: 'acme', team: 'app' }

  it('is a program, the org and the team, and optionally the data directory and a cheaper model per product', () => {
    assert.deepEqual(parseBudget(valid), valid)
    const full = { ...valid, dir: '~/agency-data', warningModel: { 'claude-code': 'model-small', codex: 'model-mini' } }
    assert.deepEqual(parseBudget(full), full)
  })

  it('is refused for a program that is not an absolute path, ids with odd characters, an unknown key or product, or a missing id', () => {
    for (const bad of [{ ...valid, command: ['agency'] }, { ...valid, command: [] }, { ...valid, org: 'a b' }, { ...valid, team: '' }, { command: valid.command, org: 'acme' }, { ...valid, extra: 1 }, { ...valid, warningModel: { gemini: 'x' } }, { ...valid, warningModel: { codex: 'bad model' } }, { ...valid, dir: 'relative' }, 'agency']) {
      assert.equal(parseBudget(bad), null, JSON.stringify(bad))
    }
  })

  it('makes the launch section ignored when it is wrong, and a member can set its own warningModel', () => {
    assert.equal(parseLaunch({ tmuxSession: 't', members: {}, budget: { command: ['x'] } }), undefined)
    assert.equal(parseLaunch({ tmuxSession: 't', members: { A: { warningModel: 'small' } } })?.members.A?.warningModel, 'small')
    assert.equal(parseLaunch({ tmuxSession: 't', members: { A: { warningModel: 'bad model' } } }), undefined)
  })
})

describe('agencyBudgetReader: what the node answers', () => {
  const reader = () => agencyBudgetReader({ command: [program(), 'budget'], org: 'acme', team: 'app', dir: '/data' })()

  it('asks `status --org <org> --team <team> --dir <dir>` after the program\'s own arguments, and reads the answer', () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), 'scrum-budget-args-')), 'args')
    answer(JSON.stringify({ weekStart: '2026-11-23', team: { capUsd: 200, spentUsd: 163.4, state: 'warning' }, org: { capUsd: 500, spentUsd: 311, state: 'ok', partial: true }, extra: 1 }), { FAKE_ARGS: argsFile })
    assert.deepEqual(reader(), { weekStart: '2026-11-23', team: { capUsd: 200, spentUsd: 163.4, state: 'warning' }, org: { capUsd: 500, spentUsd: 311, state: 'ok', partial: true } })
    assert.equal(readFileSync(argsFile, 'utf8').trim(), JSON.stringify(['budget', 'status', '--org', 'acme', '--team', 'app', '--dir', '/data']))
  })

  it('takes a budget without a cap', () => {
    answer(JSON.stringify({ weekStart: '2026-11-23', team: { spentUsd: 20, state: 'ok' }, org: { spentUsd: 20, state: 'ok' } }))
    assert.equal(reader().team.capUsd, undefined)
  })

  it('throws, with the program\'s words, for a failure, something that is not JSON, or an answer of the wrong shape', () => {
    answer('', { FAKE_EXIT: '1', FAKE_STDERR: 'no org definition' })
    assert.throws(reader, /failed \(exit 1\): no org definition/)
    answer('not json')
    assert.throws(reader, /did not answer with JSON/)
    const line = { spentUsd: 1, state: 'ok' }
    for (const bad of [{ team: line, org: line }, { weekStart: 'Monday', team: line, org: line }, { weekStart: '2026-11-23', org: line }, { weekStart: '2026-11-23', team: { ...line, state: 'maybe' }, org: line }, { weekStart: '2026-11-23', team: { ...line, spentUsd: -1 }, org: line }, { weekStart: '2026-11-23', team: { ...line, capUsd: 'x' }, org: line }, []]) {
      answer(JSON.stringify(bad))
      assert.throws(reader, /did not answer an object|weekStart|has no|not one of|not an amount/, JSON.stringify(bad))
    }
  })
})

describe('the kept budget', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-budget-state-')))
  })

  it('is written by a refresh and read back, and kept, with the reason, when the node cannot be asked', () => {
    assert.equal(refreshBudget(fakePorts({ budget: () => status('warning') }), p.budget, NOW), null)
    assert.deepEqual(readBudgetRecord(p.budget), { at: NOW.toISOString(), status: status('warning') })
    assert.match(refreshBudget(fakePorts({ budget: () => { throw new Error('agency failed (exit 1)') } }), p.budget, NOW) ?? '', /agency failed/)
    assert.equal(readBudgetRecord(p.budget)?.status.team.state, 'warning')
    assert.equal(refreshBudget(fakePorts(), p.budget, NOW), null)
  })

  it('is not acted on once it is 3 hours old, or when there is none', () => {
    refreshBudget(fakePorts({ budget: () => status('over') }), p.budget, NOW)
    const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)
    assert.equal(currentBudget(readBudgetRecord(p.budget), at(179))?.team.state, 'over')
    assert.equal(currentBudget(readBudgetRecord(p.budget), at(181)), null)
    assert.equal(currentBudget(null, NOW), null)
  })

  it('says the week after, and the spend with the caps', () => {
    assert.equal(nextWeek('2026-11-23'), '2026-11-30')
    assert.equal(nextWeek('2026-12-28'), '2027-01-04')
    assert.equal(describeBudget(status('warning')), 'team $163 of $200; org $311 of $500')
    assert.equal(describeBudget({ ...status('ok'), org: { spentUsd: 5, state: 'ok', partial: true } }), 'team $20 of $200; org $5 (partial: some spend could not be read)')
  })
})

describe('the findings of the budget', () => {
  it('is B-BUDGET-OVER (high) when the team is over, B-BUDGET-WARNING (low) at the warning, and nothing otherwise', () => {
    const [over] = lintBudget(status('over'))
    assert.deepEqual([over?.rule, over?.severity, over?.key], ['B-BUDGET-OVER', 'high', 'B-BUDGET-OVER:team:2026-11-23'])
    assert.match(over?.message ?? '', /team \$210 of \$200; org \$311 of \$500.*until 2026-11-30/)
    const [warning] = lintBudget(status('warning'))
    assert.deepEqual([warning?.rule, warning?.severity], ['B-BUDGET-WARNING', 'low'])
    assert.deepEqual([lintBudget(status('ok')), lintBudget(null)], [[], []])
  })

  it('is raised again for a new week (a new key)', () => {
    assert.notEqual(lintBudget(status('over'))[0]?.key, lintBudget(status('over', { weekStart: '2026-11-30' }))[0]?.key)
  })

  it('comes from the kept budget when the findings are worked out', () => {
    const ctx = { snapshot: { items: [], openIssues: [] }, members: [], acks: [], config: base, now: NOW } as unknown as Parameters<typeof lintAll>[0]
    assert.deepEqual(lintAll({ ...ctx, budget: status('over') }).active.filter((one) => one.rule.startsWith('B-BUDGET')).map((one) => one.rule), ['B-BUDGET-OVER'])
  })
})

describe('a member starts as the weekly budget allows', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-budget-start-')))
  })

  const config = (budget: Record<string, unknown> | null, member: Record<string, unknown> = {}): Config => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-budget-dir-'))
    const launch = parseLaunch({ tmuxSession: 'team', members: { SWE1: { dir, model: 'model-big', ...member } }, ...(budget === null ? {} : { budget: { command: ['/usr/local/bin/agency', 'budget'], org: 'acme', team: 'app', ...budget } }) })
    return { ...base, members: ['SWE1'], launch }
  }

  function run(cfg: Config, read: (() => BudgetStatus) | null, flags: Record<string, true> = {}) {
    const started: LaunchPlan[] = []
    const ports = fakePorts({
      members: { windows: () => ['home'], start: (_s: string, plan: LaunchPlan) => void started.push(plan), stop: () => undefined, screen: () => null, press: () => undefined },
      budget: read,
      launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher },
    })
    const deps: WatchdogDeps = { startFailuresPath: p.startFailures, budgetPath: p.budget, now: () => NOW, sleep: () => undefined, signals: () => [] }
    return { text: memberCommand(cfg, ports, ['start', 'SWE1'], { 'no-wait': true, ...flags }, deps), started }
  }

  const modelOf = (plan: LaunchPlan | undefined): string | undefined => plan?.argv[plan.argv.indexOf('--model') + 1]

  it('starts as usual when the budget is fine, and asks nothing without launch.budget', () => {
    assert.equal(modelOf(run(config({}), () => status('ok')).started[0]), 'model-big')
    const unset = run(config(null), () => { throw new Error('must not be asked') })
    assert.equal(unset.started.length, 1)
    assert.doesNotMatch(unset.text, /weekly budget/)
  })

  it('does not start a member when the budget is used, and says how much and until when', () => {
    const { text, started } = run(config({}), () => status('over'))
    assert.equal(started.length, 0)
    assert.match(text, /SWE1: not started: the weekly budget is used \(team \$210 of \$200; org \$311 of \$500\); no new member is started until 2026-11-30/)
  })

  it('starts on the cheaper model of its product at the warning, and says so', () => {
    const { text, started } = run(config({ warningModel: { 'claude-code': 'model-small' } }), () => status('warning'))
    assert.equal(modelOf(started[0]), 'model-small')
    assert.match(text, /SWE1: the weekly budget is at 80% or more \(team \$163 of \$200.*\); starting on model-small/)
  })

  it('lets a member\'s own warningModel replace the one of its product', () => {
    const { started } = run(config({ warningModel: { 'claude-code': 'model-small' } }, { warningModel: 'model-mid' }), () => status('warning'))
    assert.equal(modelOf(started[0]), 'model-mid')
  })

  it('leaves the model alone, and says so, when no cheaper model is set for the member', () => {
    const { text, started } = run(config({ warningModel: { codex: 'model-mini' } }), () => status('warning'))
    assert.equal(modelOf(started[0]), 'model-big')
    assert.match(text, /no warningModel is set for this member, so its model is unchanged/)
  })

  it('shows the cheaper model on a dry run, and starts nothing', () => {
    const { text, started } = run(config({ warningModel: { 'claude-code': 'model-small' } }), () => status('warning'), { 'dry-run': true })
    assert.equal(started.length, 0)
    assert.match(text, /--model model-small/)
  })

  it('uses the kept budget while it is fresh when the node cannot be asked, and starts as usual, with a note, when there is none or it is old', () => {
    const down = () => { throw new Error('agency failed (exit 1)') }
    refreshBudget(fakePorts({ budget: () => status('over') }), p.budget, NOW)
    assert.match(run(config({}), down).text, /not started: the weekly budget is used/)
    refreshBudget(fakePorts({ budget: () => status('over') }), p.budget, new Date(NOW.getTime() - 4 * 3_600_000))
    const stale = run(config({}), down)
    assert.equal(stale.started.length, 1)
    assert.match(stale.text, /the weekly budget could not be asked \(agency failed \(exit 1\)\); starting as usual/)
  })
})
