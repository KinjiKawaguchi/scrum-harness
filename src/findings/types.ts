export type Severity = 'high' | 'medium' | 'low'

/**
 * One violation of a rule. key is a fingerprint that tells whether it is "the same finding", used to judge whether it has been notified.
 */
export type Finding = {
  readonly rule: string
  readonly subject: string
  readonly key: string
  readonly severity: Severity
  readonly message: string
  readonly fix?: string
  /** For a member's finding, the minutes that the state has lasted (used for the statusline display) */
  readonly minutes?: number
}

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { high: 0, medium: 1, low: 2 }

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = { high: 'high', medium: 'medium', low: 'low' }

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
