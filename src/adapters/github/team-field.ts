import type { Config } from '../../config.ts'
import { singleSelectField } from './field-options.ts'
import type { GhRun } from './gh.ts'

/**
 * Checks that the board has the team field and that this team's value is one of its options. A misspelled value would scope the board to nothing and
 * every check would pass, so it fails the read instead.
 */
export function assertTeamValue(run: GhRun, config: Config): void {
  const scope = config.team
  if (scope === undefined) return
  const field = singleSelectField(run, config, scope.field)
  if (field === null) throw new Error(`the board has no single-select field "${scope.field}" (team.field), so the board cannot be narrowed to the team`)
  const names = field.options.map((one) => one.name)
  if (!names.includes(scope.value)) throw new Error(`"${scope.value}" (team.value) is not an option of the board's "${scope.field}" field (${names.join(', ')}), so the board copy is not rewritten`)
}
