import { bySeverity, SEVERITY_LABEL, type Finding, type Severity } from './types.ts'
import { RULES_DOC, SCRUM_CLI } from '../cli-path.ts'

export function formatFinding(finding: Finding): string {
  const fix = finding.fix === undefined ? '' : ` → ${finding.fix}`
  return `- [${SEVERITY_LABEL[finding.severity]}] ${finding.rule} ${finding.message}${fix}`
}

export function formatList(findings: readonly Finding[], limit: number): readonly string[] {
  const sorted = findings.toSorted(bySeverity)
  const shown = sorted.slice(0, limit).map(formatFinding)
  const rest = sorted.length - limit
  return rest > 0 ? [...shown, `- ${rest} more (${SCRUM_CLI} lint for all)`] : shown
}

function countBy(findings: readonly Finding[], pick: (finding: Finding) => string): ReadonlyMap<string, number> {
  return findings.reduce((acc, finding) => new Map([...acc, [pick(finding), (acc.get(pick(finding)) ?? 0) + 1]]), new Map<string, number>())
}

const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low']

/** The summary injected at the start of a session and after compaction. */
export function formatSummary(findings: readonly Finding[], ackedCount: number): string {
  const bySev = countBy(findings, (finding) => finding.severity)
  const counts = SEVERITIES.map((sev) => `${SEVERITY_LABEL[sev]} ${bySev.get(sev) ?? 0}`).join(', ')
  const rules = [...countBy(findings, (finding) => finding.rule)].map(([rule, n]) => `${rule} x${n}`).join(', ')
  const important = findings.filter((finding) => finding.severity !== 'low')
  return [
    `scrum-harness: board and member activity check (${counts}; ${ackedCount} acknowledged)`,
    rules === '' ? 'No findings' : `By rule: ${rules}`,
    ...formatList(important, 12),
    `Usage: ${SCRUM_CLI} lint (all), ${SCRUM_CLI} team (member activity), ${SCRUM_CLI} ack <rule> <subject> --for 2h --reason "<reason>" (an intended exception). Rules are explained in ${RULES_DOC}`,
  ].join('\n')
}

export function formatStatusline(findings: readonly Finding[]): string {
  const board = findings.filter((finding) => finding.rule.startsWith('B-'))
  const idle = findings.filter((finding) => finding.rule === 'T-IDLE' || finding.rule === 'T-WAITING')
  const over = findings.filter((finding) => finding.rule === 'S-POINTS-OVER').length
  const high = board.filter((finding) => finding.severity === 'high').length
  const medium = board.filter((finding) => finding.severity === 'medium').length
  if (high + medium + idle.length + over === 0) return '✓ board OK'
  const people = idle.map((finding) => {
    const mark = finding.rule === 'T-WAITING' ? 'waiting for approval ' : ''
    return `${mark}${finding.subject} ${finding.minutes ?? '?'}m`
  })
  return [
    `⚠ board high ${high} medium ${medium}`,
    ...(people.length === 0 ? [] : [`idle ${people.join(' ')}`]),
    ...(over === 0 ? [] : [`overrun ${over}`]),
  ].join(' │ ')
}
