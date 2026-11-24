import type { Config } from '../config.ts'

/**
 * PR を、その PR が指す issue の本文の、印で囲んだ範囲に並べる (紐づいたブランチから作られなかった PR の補い)。
 * 無いか enabled が true でなければ、動かない。
 */
export type LinksConfig = {
  readonly enabled: boolean
  /** 動かす間隔 (分)。TechLead の待機プロセスが、この間隔で 1 回流す */
  readonly intervalMinutes: number
  /** 1 回に書き換える issue の数の上限。初めて流したときに、たくさんの issue を一度に書き換えないため */
  readonly maxEditsPerRun: number
  /** この作者の PR は数えない (Dependabot など) */
  readonly skipAuthors: readonly string[]
  /** この文字で始まるブランチの PR は数えない (release/、sync/ など) */
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

/** links の設定を読む。形が違えば、この機能だけを止める (undefined)。足りない項目は既定で埋める。 */
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
