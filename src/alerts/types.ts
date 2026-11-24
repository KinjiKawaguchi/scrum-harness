import type { Finding } from '../findings/types.ts'

/** 止まりの検知が、待機プロセスをまたいで覚える状態。 */
export type AlertState = {
  /** 動いている人がいない Epic ("<リポジトリ名>#番号") と、それを最初に見た時刻 */
  readonly epics: Readonly<Record<string, string>>
  /** 渡せる issue が無い部下と、それを最初に見た時刻 */
  readonly empty: Readonly<Record<string, string>>
  /** macOS の通知を出した通知の指紋 */
  readonly desktopSent: readonly string[]
  /** 窓口に送った通知の指紋 */
  readonly liaisonSent: readonly string[]
  /** Epic ごとの、最後にオーナーへ E-STALL を通知した時刻。同じ Epic を重ねて通知しないために使う */
  readonly ownerPushedAt: Readonly<Record<string, string>>
}

export const EMPTY_ALERT_STATE: AlertState = { epics: {}, empty: {}, desktopSent: [], liaisonSent: [], ownerPushedAt: {} }

/**
 * 窓口とオーナーへの通知。key は同じ通知かを見分ける指紋で、出した後は同じ key を重ねて出さない。
 * owner はオーナーへの PushNotification と macOS の通知を伴う。idle-line (部下の空き) と info (オーナーへは
 * 送らないと決めた通知) は、窓口に読ませるだけの 1 行。
 */
export type Notice = {
  readonly key: string
  readonly kind: 'idle-line' | 'owner' | 'info'
  /** 窓口に送る本文 (そのままオーナーに送る文を含む) */
  readonly text: string
  /** macOS の通知 (音なし)。無いものは出さない */
  readonly desktop?: { readonly title: string; readonly body: string }
  /** 同じ対象 (Epic、部下) のオーナーへの通知を、minutes 分に 1 回までにするための印。detail は、送らないときに窓口に読ませる内容 */
  readonly throttle?: { readonly key: string; readonly head: string; readonly detail: string; readonly minutes: number }
  /** 1 回の評価で出た通知を 1 通にまとめたとき、まとめた通知の指紋 (無ければ、この通知の key だけ)。出した印は、まとめた分をすべて覚える */
  readonly members?: readonly string[]
  /** オーナーへの通知 1 件の、1 行の説明と、問いを添える対象。まとめるときに、行を並べるのに使う */
  readonly owner?: { readonly line: string; readonly waiting: readonly string[] }
}

/** 同じ材料から作る、TechLead への指摘とオーナーへの通知。通知の key は指摘の key と同じ。 */
export type AlertEvaluation = { readonly findings: readonly Finding[]; readonly owner: readonly Notice[] }
