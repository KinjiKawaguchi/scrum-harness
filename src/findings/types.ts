export type Severity = 'high' | 'medium' | 'low'

/**
 * 規則に反している1件。key は「同じ指摘か」を見分ける指紋で、通知済みかの判定に使う。
 */
export type Finding = {
  readonly rule: string
  readonly subject: string
  readonly key: string
  readonly severity: Severity
  readonly message: string
  readonly fix?: string
  /** 部下の指摘の、その状態が続いている分数 (statusline の表示に使う) */
  readonly minutes?: number
}

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { high: 0, medium: 1, low: 2 }

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = { high: '高', medium: '中', low: '低' }

export function makeFinding(input: Omit<Finding, 'key'> & { readonly keySuffix?: string }): Finding {
  const { keySuffix, ...rest } = input
  const base = `${rest.rule}:${rest.subject}`
  return { ...rest, key: keySuffix === undefined ? base : `${base}:${keySuffix}` }
}

export function bySeverity(a: Finding, b: Finding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.key.localeCompare(b.key)
}

export function atLeast(severity: Severity): (finding: Finding) => boolean {
  return (finding) => SEVERITY_RANK[finding.severity] <= SEVERITY_RANK[severity]
}
