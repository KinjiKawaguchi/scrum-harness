import type { Config } from '../config.ts'
import { offsetMinutes } from '../dispatch/idle-ack.ts'

/**
 * Settings for the agency-runtime/1 commands. All optional.
 * `blockedReasons` names the board's blocked reasons that Agency's fixed set does not have a name for.
 * The "needs decision" reason is the top-level `reasonJudge`; an unlisted reason is reported as `external`.
 */
export type RuntimeConfig = {
  /** The team's display name. Defaults to the team id the node sends. */
  readonly label?: string
  /** The time zone `tokenUsage` cuts days in, as an offset from UTC ("+09:00"). Defaults to the sprint's offset, then to UTC. */
  readonly utcOffset?: string
  /** Reads the parent (epic) of every issue, so the events of the `activity` op carry their epic. Off by default: it adds a field to every issue the board read asks for, and an older GitHub Enterprise Server may not have it. */
  readonly activity?: boolean
  /** How many days an epic stays in the view after its last child was finished (default 30; 0 drops it at once) */
  readonly finishedEpicDays?: number
  readonly blockedReasons?: {
    readonly external?: string
    readonly waitingOnPrevious?: string
    readonly timeOrEquipment?: string
  }
}

const OFFSET = /^[+-]\d{2}:\d{2}$/
const REASON_KEYS = ['external', 'waitingOnPrevious', 'timeOrEquipment'] as const

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** Reads the `runtime` section. A section of the wrong shape is ignored (undefined), so the other features keep working. */
export function parseRuntime(raw: unknown): RuntimeConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { label, utcOffset, activity, finishedEpicDays, blockedReasons } = raw as Record<string, unknown>
  if (label !== undefined && !isNonEmptyString(label)) return undefined
  if (utcOffset !== undefined && !(typeof utcOffset === 'string' && OFFSET.test(utcOffset))) return undefined
  if (activity !== undefined && typeof activity !== 'boolean') return undefined
  if (finishedEpicDays !== undefined && !(typeof finishedEpicDays === 'number' && Number.isInteger(finishedEpicDays) && finishedEpicDays >= 0 && finishedEpicDays <= 365)) return undefined
  const head = { ...(label === undefined ? {} : { label }), ...(utcOffset === undefined ? {} : { utcOffset }), ...(activity === undefined ? {} : { activity }), ...(finishedEpicDays === undefined ? {} : { finishedEpicDays }) }
  if (blockedReasons === undefined) return head
  if (typeof blockedReasons !== 'object' || blockedReasons === null) return undefined
  const names = blockedReasons as Record<string, unknown>
  if (!REASON_KEYS.every((key) => names[key] === undefined || isNonEmptyString(names[key]))) return undefined
  const picked = Object.fromEntries(REASON_KEYS.flatMap((key) => (names[key] === undefined ? [] : [[key, names[key]]])))
  return { ...head, blockedReasons: picked }
}

export function runtimeOf(config: Config): RuntimeConfig {
  return config.runtime ?? {}
}

/** The offset `tokenUsage` cuts days in, in minutes east of UTC. */
export function usageOffsetMinutes(config: Config): number {
  return offsetMinutes(runtimeOf(config).utcOffset ?? config.sprint?.utcOffset ?? '+00:00')
}
