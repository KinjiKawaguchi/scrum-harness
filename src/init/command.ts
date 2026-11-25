import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ADAPTERS, DEFAULT_TUNING, parseConfig } from '../config.ts'
import { writeJson } from '../store.ts'

export const INIT_USAGE = `Usage: scrum init --project-id <PVT_...> --status-field-id <PVTSSF_...> --repos <owner/name[,owner/name]> --owner-user <@login>
                  [--techlead <name>] [--members <a,b>] [--liaison <name>] [--owner-label <text>] [--default-repo <owner/name>]
                  [--exclude-authors <a,b>] [--state-dir <dir>] [--force]
Writes a minimal team configuration (config.json) and the state directory. It asks nothing.
The board's ids: gh project list --owner <owner>; gh project field-list <number> --owner <owner> --format json (the id of the Status field).`

export type InitFlags = Readonly<Record<string, string | true>>

const text = (flags: InitFlags, key: string): string | undefined => (typeof flags[key] === 'string' ? (flags[key] as string) : undefined)
const list = (value: string | undefined): readonly string[] => (value ?? '').split(',').map((one) => one.trim()).filter((one) => one !== '')

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/
const PROJECT_ID = /^PVT_[A-Za-z0-9_-]+$/
const FIELD_ID = /^PVTSSF_[A-Za-z0-9_-]+$/

/** The folders the harness writes into under the state directory. */
export const STATE_FOLDERS = ['cache', 'log', 'team', 'identity', 'notify', 'requests'] as const

/** The configuration `init` writes, or the list of what is wrong with the flags. Pure. */
export function configFromFlags(flags: InitFlags): { readonly config: Record<string, unknown> } | { readonly problems: readonly string[] } {
  const projectId = text(flags, 'project-id') ?? ''
  const statusFieldId = text(flags, 'status-field-id') ?? ''
  const repos = list(text(flags, 'repos'))
  const defaultRepo = text(flags, 'default-repo') ?? repos[0] ?? ''
  const ownerUser = text(flags, 'owner-user') ?? ''
  const techlead = text(flags, 'techlead') ?? 'TechLead'
  const members = text(flags, 'members') === undefined ? ['SWE1', 'SWE2'] : list(text(flags, 'members'))
  const liaison = text(flags, 'liaison')
  const problems = [
    PROJECT_ID.test(projectId) ? null : '--project-id must be the board\'s node id (PVT_...)',
    FIELD_ID.test(statusFieldId) ? null : '--status-field-id must be the Status field\'s node id (PVTSSF_...)',
    repos.length > 0 && repos.every((repo) => REPO.test(repo)) ? null : '--repos must list owner/name, comma separated',
    repos.includes(defaultRepo) ? null : '--default-repo must be one of --repos',
    ownerUser.startsWith('@') && ownerUser.length > 1 ? null : '--owner-user must be a GitHub login written with @',
    [techlead, ...members, ...(liaison === undefined ? [] : [liaison])].every((name) => NAME.test(name)) ? null : 'session names may hold letters, digits, spaces, dots, dashes, and underscores',
    new Set([techlead, ...members, ...(liaison === undefined ? [] : [liaison])]).size === members.length + 1 + (liaison === undefined ? 0 : 1) ? null : 'the lead, the members, and the liaison need different names',
  ].filter((problem): problem is string => problem !== null)
  if (problems.length > 0) return { problems }
  const excludeAuthors = list(text(flags, 'exclude-authors'))
  return {
    config: {
      projectId,
      repos,
      defaultRepo,
      fields: { status: 'Status', reason: 'Blocked reason', since: 'Blocked since', owner: 'Owner', assignee: 'Assigned to' },
      statusFieldId,
      statuses: { backlog: 'Backlog', next: 'Next', doing: 'In Progress', release: 'Release', done: 'Done' },
      reasonNone: 'None',
      reasonJudge: 'Needs decision',
      ownerUser,
      excludeAuthors,
      techlead,
      members,
      ownerLabel: text(flags, 'owner-label') ?? DEFAULT_ADAPTERS.ownerLabel,
      scripts: {},
      ...DEFAULT_TUNING,
      ...(liaison === undefined ? {} : { alerts: { enabled: true, liaison } }),
    },
  }
}

export type InitResult = { readonly ok: boolean; readonly text: string }

/**
 * `scrum init`: writes the configuration and creates the state directory, from flags only. It does not overwrite a configuration unless `--force` is given.
 * The configuration it writes has no board scripts and no sprint, dispatch, or links sections: those stay off until the team adds them.
 */
export function initCommand(stateDir: string, isDefaultStateDir: boolean, scrum: string, flags: InitFlags): InitResult {
  const built = configFromFlags(flags)
  if ('problems' in built) return { ok: false, text: [...built.problems, '', INIT_USAGE].join('\n') }
  if (parseConfig(built.config) === null) return { ok: false, text: 'The configuration built from the flags is not valid; this is a bug in scrum init' }
  const configFile = join(stateDir, 'config.json')
  if (existsSync(configFile) && flags.force !== true) return { ok: false, text: `${configFile} already exists; pass --force to replace it` }
  for (const folder of STATE_FOLDERS) mkdirSync(join(stateDir, folder), { recursive: true })
  writeJson(configFile, built.config)
  const env = isDefaultStateDir ? '' : `export SCRUM_STATE_DIR=${stateDir}   # every scrum command and hook of this team needs it\n`
  return {
    ok: true,
    text: [
      `Wrote ${configFile} and the state directory ${stateDir}.`,
      'Next:',
      `${env}${scrum} refresh && ${scrum} lint        # read the board and check the findings`,
      `${scrum} install                          # add the hooks to ~/.claude/settings.json`,
      `${scrum} schedule install${isDefaultStateDir ? '' : ' --name <team>'}   # run the background loop (needs alerts.enabled to do anything)`,
    ].filter((line) => line !== '').join('\n'),
  }
}
