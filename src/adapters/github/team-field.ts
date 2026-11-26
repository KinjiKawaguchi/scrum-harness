import type { TeamScope } from '../../board/team-scope.ts'
import type { Config } from '../../config.ts'
import type { GhRun } from './gh.ts'

const OPTIONS_QUERY =
  'query($id:ID!, $name:String!){ node(id:$id){ ... on ProjectV2 { field(name:$name){ ... on ProjectV2SingleSelectField { options{ name } } } } } }'

/** The option names of the team field, or null when the board has no single-select field of that name. */
function teamOptions(run: GhRun, config: Config, scope: TeamScope): readonly string[] | null {
  const out = run(['api', 'graphql', '-f', `query=${OPTIONS_QUERY}`, '-F', `id=${config.projectId}`, '-f', `name=${scope.field}`])
  const options = (JSON.parse(out) as { data?: { node?: { field?: { options?: readonly { name?: string }[] } | null } | null } }).data?.node?.field?.options
  return options === undefined ? null : options.flatMap((one) => (typeof one.name === 'string' ? [one.name] : []))
}

/**
 * Checks that the board has the team field and that this team's value is one of its options. A misspelled value would scope the board to nothing and
 * every check would pass, so it fails the read instead.
 */
export function assertTeamValue(run: GhRun, config: Config): void {
  const scope = config.team
  if (scope === undefined) return
  const options = teamOptions(run, config, scope)
  if (options === null) throw new Error(`the board has no single-select field "${scope.field}" (team.field), so the board cannot be narrowed to the team`)
  if (!options.includes(scope.value)) throw new Error(`"${scope.value}" (team.value) is not an option of the board's "${scope.field}" field (${options.join(', ')}), so the board copy is not rewritten`)
}
