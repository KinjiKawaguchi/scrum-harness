import type { Config } from '../config.ts'

/**
 * Settings for the agency-runtime/1 commands. All optional.
 * `blockedReasons` names the board's blocked reasons that Agency's fixed set does not have a name for.
 * The "needs decision" reason is the top-level `reasonJudge`; an unlisted reason is reported as `external`.
 */
export type RuntimeConfig = {
  /** The team's display name. Defaults to the team id the node sends. */
  readonly label?: string
  readonly blockedReasons?: {
    readonly external?: string
    readonly waitingOnPrevious?: string
    readonly timeOrEquipment?: string
  }
}

const REASON_KEYS = ['external', 'waitingOnPrevious', 'timeOrEquipment'] as const

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** Reads the `runtime` section. A section of the wrong shape is ignored (undefined), so the other features keep working. */
export function parseRuntime(raw: unknown): RuntimeConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { label, blockedReasons } = raw as Record<string, unknown>
  if (label !== undefined && !isNonEmptyString(label)) return undefined
  if (blockedReasons === undefined) return label === undefined ? {} : { label }
  if (typeof blockedReasons !== 'object' || blockedReasons === null) return undefined
  const names = blockedReasons as Record<string, unknown>
  if (!REASON_KEYS.every((key) => names[key] === undefined || isNonEmptyString(names[key]))) return undefined
  const picked = Object.fromEntries(REASON_KEYS.flatMap((key) => (names[key] === undefined ? [] : [[key, names[key]]])))
  return { ...(label === undefined ? {} : { label }), blockedReasons: picked }
}

export function runtimeOf(config: Config): RuntimeConfig {
  return config.runtime ?? {}
}
