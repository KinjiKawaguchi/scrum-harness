import { readFileSync } from 'node:fs'
import { isCommandConfig, type AdaptersConfig } from '../../adapter-module.ts'
import type { BoardCommand } from '../../board/commands.ts'
import { snapshotProblems } from '../../board/snapshot-check.ts'
import type { Config } from '../../config.ts'
import type { ToolCall } from '../../ports/index.ts'
import { rawCommandPorts } from '../command/ports.ts'
import { loadRawModulePorts } from './load.ts'

export type CheckResult = { readonly text: string; readonly isOk: boolean }

type CallCase = { readonly call: ToolCall; readonly expect?: readonly BoardCommand[] }

const what = (spec: AdaptersConfig): string => (isCommandConfig(spec) ? `program      ${spec.command.join(' ')}` : `module       ${spec.module}`)
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 400)

function readCases(path: string): readonly CallCase[] | string {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const isCase = (one: unknown): one is CallCase => typeof one === 'object' && one !== null && typeof (one as CallCase).call?.tool === 'string' && typeof (one as CallCase).call?.input === 'object'
    return Array.isArray(raw) && raw.every(isCase) ? raw : `${path} must be a list of { "call": { "tool", "input", "response"? }, "expect": [ ...commands ]? }`
  } catch (error) {
    return `cannot read ${path}: ${message(error)}`
  }
}

function checkSnapshot(ports: ReturnType<typeof loadRawModulePorts>, config: Config, now: Date): { readonly lines: readonly string[]; readonly problems: number } {
  if (ports.board === undefined) return { lines: ['snapshot     (no board: the GitHub board is used)'], problems: 0 }
  try {
    const snapshot = ports.board.fetchSnapshot(now)
    const problems = snapshotProblems(snapshot, config)
    return { lines: [`snapshot     ${snapshot.items?.length ?? '?'} items, ${snapshot.openIssues?.length ?? '?'} open issues, ${problems.length} problems`, ...problems.map((one) => `  - ${one}`)], problems: problems.length }
  } catch (error) {
    return { lines: [`snapshot     FAILED: ${message(error)}`], problems: 1 }
  }
}

function checkPatterns(ports: ReturnType<typeof loadRawModulePorts>): { readonly lines: readonly string[]; readonly problems: number } {
  if (ports.actions === undefined) return { lines: [], problems: 0 }
  try {
    const { post, pre } = ports.actions.shellPatterns()
    const broken = [post, pre].filter((pattern) => typeof pattern !== 'string' || (() => { try { new RegExp(pattern); return false } catch { return true } })())
    return { lines: [`patterns     post ${JSON.stringify(post)}, pre ${JSON.stringify(pre)}${broken.length > 0 ? ' (not a valid pattern)' : ''}`], problems: broken.length }
  } catch (error) {
    return { lines: [`patterns     FAILED: ${message(error)}`], problems: 1 }
  }
}

function checkCalls(ports: ReturnType<typeof loadRawModulePorts>, cases: readonly CallCase[]): { readonly lines: readonly string[]; readonly problems: number } {
  const actions = ports.actions
  if (actions === undefined) return { lines: ['calls        (no action reader in the module)'], problems: cases.length > 0 ? 1 : 0 }
  const results = cases.map((one, index) => {
    try {
      const commands = actions.actionsOf(one.call)
      const isMatch = one.expect === undefined || JSON.stringify(commands) === JSON.stringify(one.expect)
      return { isMatch, text: `  ${isMatch ? 'ok  ' : 'DIFF'} #${index + 1} ${one.call.tool} -> ${JSON.stringify(commands)}${isMatch ? '' : ` (expected ${JSON.stringify(one.expect)})`}` }
    } catch (error) {
      return { isMatch: false, text: `  FAIL #${index + 1} ${one.call.tool}: ${message(error)}` }
    }
  })
  return { lines: [`calls        ${results.filter((one) => one.isMatch).length} of ${results.length} as expected`, ...results.map((one) => one.text)], problems: results.filter((one) => !one.isMatch).length }
}

/**
 * `scrum adapter check`: loads a board module and checks what can be checked without writing to the tracker: the ports and their shape, the snapshot
 * it reads (shape, references, statuses), the patterns of its action reader, and, from a file of cases, what its action reader makes of tool calls.
 * The writes are not exercised, because they would change the tracker.
 */
export function checkBoardModule(spec: AdaptersConfig, config: Config, now: Date, callsFile?: string): CheckResult {
  const cases = callsFile === undefined ? [] : readCases(callsFile)
  if (typeof cases === 'string') return { text: cases, isOk: false }
  let ports: ReturnType<typeof loadRawModulePorts>
  try {
    ports = isCommandConfig(spec) ? rawCommandPorts(spec, config) : loadRawModulePorts(spec, config)
  } catch (error) {
    return { text: `${what(spec)}\nload         FAILED: ${message(error)}`, isOk: false }
  }
  const provided = Object.keys(ports)
  const checks = [checkSnapshot(ports, config, now), checkPatterns(ports), checkCalls(ports, cases)]
  const problems = checks.reduce((total, one) => total + one.problems, 0)
  const lines = [
    what(spec),
    'load         ok',
    `ports        ${provided.length === 0 ? 'none (everything is GitHub)' : provided.join(', ')}${provided.length < 5 ? ` (the rest is GitHub)` : ''}`,
    ...checks.flatMap((one) => one.lines),
    'not checked  the writes (they would change the tracker) and the issue thread',
    problems === 0 ? 'result       ok' : `result       ${problems} problem${problems === 1 ? '' : 's'}`,
  ]
  return { text: lines.join('\n'), isOk: problems === 0 }
}
