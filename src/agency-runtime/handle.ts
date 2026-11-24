import { isRefreshDue, loadSnapshot } from '../board/snapshot.ts'
import type { Config } from '../config.ts'
import { collectSignals } from '../findings/lint.ts'
import type { Ports } from '../ports/index.ts'
import { readRequests } from '../requests/store.ts'
import type { Paths } from '../store.ts'
import { aggregateMembers } from '../team/state.ts'
import { runtimeOf } from './config.ts'
import { decide } from './decide.ts'
import { isRuntimeError, parseRuntimeRequest } from './request.ts'
import { RUNTIME_VERSION, type Describe, type RuntimeError, type RuntimeRequest, type RuntimeResponse } from './types.ts'
import { teamViewProblem } from './validate.ts'
import { buildTeamView } from './view.ts'

export type RuntimeDeps = {
  readonly p: Paths
  readonly config: Config
  readonly now: Date
  readonly ports: Pick<Ports, 'board' | 'writer' | 'issues' | 'sessions'>
  /** Starts a board refresh in the background, so a call never waits for the board. */
  readonly spawnRefresh: () => void
}

const OPS = ['describe', 'view', 'decide']
const fail = (status: number, message: string): { readonly error: RuntimeError } => ({ error: { status, message } })

function labelOf(request: RuntimeRequest, config: Config): string {
  return runtimeOf(config).label ?? request.team
}

function view(request: RuntimeRequest, deps: RuntimeDeps): RuntimeResponse<unknown> {
  const { p, config, now, ports } = deps
  const snapshot = loadSnapshot(p)
  if (isRefreshDue(p, config, now)) deps.spawnRefresh()
  if (snapshot === null) return fail(503, 'the board has not been read yet; a refresh was started')
  const names = [config.techlead, ...config.members]
  const members = aggregateMembers(collectSignals(p, now, ports.sessions), names)
  const teamView = buildTeamView({ org: request.org, team: request.team, label: labelOf(request, config), config, snapshot, members, stored: readRequests(p), now })
  const problem = teamViewProblem(teamView)
  return problem === null ? { result: teamView } : fail(503, `the team view is not valid: ${problem}`)
}

function handle(request: RuntimeRequest, deps: RuntimeDeps): RuntimeResponse<unknown> {
  if (request.op === 'describe') {
    const description: Describe = { runtimes: [RUNTIME_VERSION], ops: OPS, label: labelOf(request, deps.config) }
    return { result: description }
  }
  if (request.op === 'view') return view(request, deps)
  const error = decide(deps, request.decision)
  return error === null ? { result: {} } : { error }
}

export type RuntimeOutput = { readonly stdout: string; readonly exitCode: 0 | 1 }

/**
 * One call of agency-runtime/1: a JSON request in, one JSON response out. The exit code is 0 for a result and 1 for an error.
 * `deps` is null when the harness is not configured.
 */
export function runRuntime(input: string, deps: RuntimeDeps | null): RuntimeOutput {
  const request = parseRuntimeRequest(input)
  const response: RuntimeResponse<unknown> = (() => {
    if (isRuntimeError(request)) return { error: request }
    if (deps === null) return fail(503, 'scrum-harness is not configured')
    try {
      return handle(request, deps)
    } catch (error) {
      return fail(503, `the runtime cannot act now: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`)
    }
  })()
  return { stdout: `${JSON.stringify(response)}\n`, exitCode: 'result' in response ? 0 : 1 }
}
