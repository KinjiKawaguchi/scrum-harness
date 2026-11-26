import { readFileSync, statSync } from 'node:fs'
import type { Config } from '../config.ts'
import { expandHome } from '../paths.ts'
import type { LaunchPlan, ProductLauncher } from '../ports/index.ts'
import type { MemberSpec, Product } from './config.ts'

export type Planned = { readonly plan: LaunchPlan; readonly brief: string; readonly spec: MemberSpec } | { readonly problem: string }

/** What a member's settings come to: the defaults, then the member's own. */
export function specOf(config: Config, name: string): MemberSpec {
  return { ...config.launch?.defaults, ...config.launch?.members[name] }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The brief a member starts with: the text of its file, or nothing when none is configured. Null when the file cannot be read. */
function briefOf(spec: MemberSpec): string | null {
  if (spec.brief === undefined) return ''
  try {
    return readFileSync(expandHome(spec.brief), 'utf8').trim()
  } catch {
    return null
  }
}

export type PlanOptions = {
  /** The account the node picked: what to set for the session */
  readonly pickedEnv?: Readonly<Record<string, string>>
  /** Continue a session instead of starting a new conversation, with `note` as the first message (not the member's brief) */
  readonly resume?: { readonly sessionId: string; readonly note: string }
}

/**
 * The plan to start one member: where, with what environment, and the command line of its product. The environment is what the member's hooks and
 * sessions need to report to this team (`SCRUM_STATE_DIR`, `SCRUM_NAME`), the Claude Code configuration directory when the member has one, and this
 * process's PATH, because a terminal multiplexer's server may have a shorter one that lacks `gh`.
 */
export function planMember(config: Config, name: string, stateDir: string, path: string | undefined, launchers: Readonly<Record<Product, ProductLauncher>>, options: PlanOptions = {}): Planned {
  const { pickedEnv = {}, resume } = options
  const spec = specOf(config, name)
  if (spec.dir === undefined) return { problem: `${name} has no directory: set launch.members.${name}.dir (or launch.defaults.dir)` }
  const dir = expandHome(spec.dir)
  if (!isDirectory(dir)) return { problem: `the directory of ${name} does not exist: ${dir}` }
  const brief = resume === undefined ? briefOf(spec) : resume.note
  if (brief === null) return { problem: `the brief of ${name} cannot be read: ${spec.brief}` }
  const argv = launchers[spec.product ?? 'claude-code']({ name, spec, brief, ...(resume === undefined ? {} : { resume: resume.sessionId }) })
  const env = {
    SCRUM_STATE_DIR: stateDir,
    SCRUM_NAME: name,
    // The account the node picked, unless the member is pinned to its own configuration directory.
    ...pickedEnv,
    ...(spec.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: expandHome(spec.configDir) }),
    ...(path === undefined ? {} : { PATH: path }),
  }
  return { plan: { name, dir, env, argv }, brief, spec }
}
