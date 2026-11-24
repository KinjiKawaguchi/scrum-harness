import type { Config } from '../config.ts'

/**
 * 止まりの検知 (E-STALL、Q-EMPTY) と、窓口・オーナーへの通知。無いか enabled が true でなければ、動かない。
 * 何を、誰に、いつ伝えるかはハーネスが決める。窓口のセッションは、決まった文を送る手になるだけ。
 */
export type AlertsConfig = {
  readonly enabled: boolean
  /** 窓口のセッションの名前。この名前のセッションが待機して、ハーネスが決めた通知の文を受け取る */
  readonly liaison?: string
  /** 動いている人がいない Epic を、E-STALL として出すまでの分数 */
  readonly epicStallMinutes: number
  /** 渡せる issue が無い部下を、オーナーにも伝えるまでの分数 */
  readonly emptyEscalateMinutes: number
  /** ハーネスが macOS の通知 (音なし) を直接出すか。窓口が作業中でも、オーナーに届くようにする */
  readonly isDesktopEnabled: boolean
  /** この名前のラベルが付いた Epic は、意図して積んであるので、E-STALL に数えない (ラベルを付けるのは TechLead) */
  readonly parkedLabels: readonly string[]
  /** 同じ Epic の E-STALL を、オーナーに通知する間隔の下限 (分)。TechLead と窓口には、この間隔に関係なく伝わる */
  readonly epicPushMinutes: number
  /** 渡せる issue が無い同じ部下 (Q-EMPTY-OWNER) を、オーナーに通知する間隔の下限 (分) */
  readonly emptyPushMinutes: number
}

export const DEFAULT_ALERTS: AlertsConfig = {
  enabled: false,
  epicStallMinutes: 60,
  emptyEscalateMinutes: 30,
  isDesktopEnabled: true,
  parkedLabels: ['epic:parked'],
  epicPushMinutes: 24 * 60,
  emptyPushMinutes: 60,
}

export function alertsOf(config: Config): AlertsConfig {
  return config.alerts ?? DEFAULT_ALERTS
}

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')
const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** alerts の設定を読む。形が違えば、この機能だけを止める (undefined)。足りない項目は既定で埋める。 */
export function parseAlerts(raw: unknown): AlertsConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { enabled, liaison, epicStallMinutes, emptyEscalateMinutes, isDesktopEnabled, parkedLabels, epicPushMinutes, emptyPushMinutes } = raw as Record<string, unknown>
  const isValid =
    typeof enabled === 'boolean' &&
    (liaison === undefined || (typeof liaison === 'string' && liaison !== '')) &&
    (epicStallMinutes === undefined || isPositiveNumber(epicStallMinutes)) &&
    (emptyEscalateMinutes === undefined || isPositiveNumber(emptyEscalateMinutes)) &&
    (isDesktopEnabled === undefined || typeof isDesktopEnabled === 'boolean') &&
    (parkedLabels === undefined || isStringList(parkedLabels)) &&
    (epicPushMinutes === undefined || isPositiveNumber(epicPushMinutes)) &&
    (emptyPushMinutes === undefined || isPositiveNumber(emptyPushMinutes))
  if (!isValid) return undefined
  return {
    enabled,
    ...(liaison === undefined ? {} : { liaison: liaison as string }),
    epicStallMinutes: (epicStallMinutes as number | undefined) ?? DEFAULT_ALERTS.epicStallMinutes,
    emptyEscalateMinutes: (emptyEscalateMinutes as number | undefined) ?? DEFAULT_ALERTS.emptyEscalateMinutes,
    isDesktopEnabled: (isDesktopEnabled as boolean | undefined) ?? DEFAULT_ALERTS.isDesktopEnabled,
    parkedLabels: (parkedLabels as readonly string[] | undefined) ?? DEFAULT_ALERTS.parkedLabels,
    epicPushMinutes: (epicPushMinutes as number | undefined) ?? DEFAULT_ALERTS.epicPushMinutes,
    emptyPushMinutes: (emptyPushMinutes as number | undefined) ?? DEFAULT_ALERTS.emptyPushMinutes,
  }
}
