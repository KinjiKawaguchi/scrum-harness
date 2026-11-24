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
  return rest > 0 ? [...shown, `- ほか ${rest} 件 (${SCRUM_CLI} lint で全件)`] : shown
}

function countBy(findings: readonly Finding[], pick: (finding: Finding) => string): ReadonlyMap<string, number> {
  return findings.reduce((acc, finding) => new Map([...acc, [pick(finding), (acc.get(pick(finding)) ?? 0) + 1]]), new Map<string, number>())
}

const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low']

/** セッションの始まりと圧縮の後に入れる要約。 */
export function formatSummary(findings: readonly Finding[], ackedCount: number): string {
  const bySev = countBy(findings, (finding) => finding.severity)
  const counts = SEVERITIES.map((sev) => `${SEVERITY_LABEL[sev]} ${bySev.get(sev) ?? 0} 件`).join('、')
  const rules = [...countBy(findings, (finding) => finding.rule)].map(([rule, n]) => `${rule} ×${n}`).join('、')
  const important = findings.filter((finding) => finding.severity !== 'low')
  return [
    `scrum-harness: ボードと部下の稼働の点検 (${counts}、受け入れ済み ${ackedCount} 件)`,
    rules === '' ? '指摘なし' : `規則ごと: ${rules}`,
    ...formatList(important, 12),
    `使い方: ${SCRUM_CLI} lint (全件)、${SCRUM_CLI} team (部下の稼働)、${SCRUM_CLI} ack <規則> <対象> --for 2h --reason "<理由>" (意図した例外)。規則の説明は ${RULES_DOC}`,
  ].join('\n')
}

export function formatStatusline(findings: readonly Finding[]): string {
  const board = findings.filter((finding) => finding.rule.startsWith('B-'))
  const idle = findings.filter((finding) => finding.rule === 'T-IDLE' || finding.rule === 'T-WAITING')
  const over = findings.filter((finding) => finding.rule === 'S-POINTS-OVER').length
  const high = board.filter((finding) => finding.severity === 'high').length
  const medium = board.filter((finding) => finding.severity === 'medium').length
  if (high + medium + idle.length + over === 0) return '✓ ボード OK'
  const people = idle.map((finding) => {
    const mark = finding.rule === 'T-WAITING' ? '許可待ち ' : ''
    return `${mark}${finding.subject} ${finding.minutes ?? '?'}分`
  })
  return [
    `⚠ ボード 高${high} 中${medium}`,
    ...(people.length === 0 ? [] : [`空き ${people.join(' ')}`]),
    ...(over === 0 ? [] : [`超過 ${over}`]),
  ].join(' │ ')
}
