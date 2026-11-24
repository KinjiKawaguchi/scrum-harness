import type { Config } from '../config.ts'

/**
 * Lines up PRs in the range, enclosed by markers, of the body of the issue each PR points at (supplements PRs that were not made from a linked branch).
 * If absent or enabled is not true, it does not run.
 */
export type LinksConfig = {
  readonly enabled: boolean
  /** The interval (minutes) at which to run. The TechLead's watch process runs it once per this interval */
  readonly intervalMinutes: number
  /** The upper limit on the number of issues rewritten in one run. So that many issues are not rewritten at once on the first run */
  readonly maxEditsPerRun: number
  /** PRs by this author are not counted (Dependabot and the like) */
  readonly skipAuthors: readonly string[]
  /** PRs on branches starting with these characters are not counted (release/, sync/, and the like) */
  readonly skipBranchPrefixes: readonly string[]
}

export const DEFAULT_LINKS: LinksConfig = {
  enabled: false,
  intervalMinutes: 30,
  maxEditsPerRun: 20,
  skipAuthors: ['app/dependabot', 'dependabot[bot]', 'dependabot'],
  skipBranchPrefixes: ['release/', 'sync/'],
}

export function linksOf(config: Config): LinksConfig {
  return config.links ?? DEFAULT_LINKS
}

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')
const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

/** Reads the links config. If the shape differs, only this feature is stopped (undefined). Missing items are filled with defaults. */
export function parseLinks(raw: unknown): LinksConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { enabled, intervalMinutes, maxEditsPerRun, skipAuthors, skipBranchPrefixes } = raw as Record<string, unknown>
  const isValid =
    typeof enabled === 'boolean' &&
    (intervalMinutes === undefined || isPositiveInteger(intervalMinutes)) &&
    (maxEditsPerRun === undefined || isPositiveInteger(maxEditsPerRun)) &&
    (skipAuthors === undefined || isStringList(skipAuthors)) &&
    (skipBranchPrefixes === undefined || isStringList(skipBranchPrefixes))
  if (!isValid) return undefined
  return {
    enabled,
    intervalMinutes: (intervalMinutes as number | undefined) ?? DEFAULT_LINKS.intervalMinutes,
    maxEditsPerRun: (maxEditsPerRun as number | undefined) ?? DEFAULT_LINKS.maxEditsPerRun,
    skipAuthors: (skipAuthors as readonly string[] | undefined) ?? DEFAULT_LINKS.skipAuthors,
    skipBranchPrefixes: (skipBranchPrefixes as readonly string[] | undefined) ?? DEFAULT_LINKS.skipBranchPrefixes,
  }
}
