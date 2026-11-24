import { atLeast, type Finding, type Severity } from './types.ts'

/** Findings of the specified severity or higher that have not been notified yet. */
export function unseen(findings: readonly Finding[], seenKeys: readonly string[], min: Severity): readonly Finding[] {
  const seen = new Set(seenKeys)
  return findings.filter(atLeast(min)).filter((finding) => !seen.has(finding.key))
}

/**
 * Remembers the fingerprints that were notified. Only the fingerprints of current findings are kept, so a finding that arises again after being fixed is notified again.
 */
export function remember(
  seenKeys: readonly string[],
  current: readonly Finding[],
  added: readonly Finding[],
): readonly string[] {
  const currentKeys = new Set(current.map((finding) => finding.key))
  const merged = new Set([...seenKeys, ...added.map((finding) => finding.key)])
  return [...merged].filter((key) => currentKeys.has(key)).toSorted()
}

/**
 * Whether to stop the end of the turn. It stops only when there is a high finding that has never been stopped on,
 * and does not stop on a turn that continues from a Stop hook (stop_hook_active).
 */
export function decideStop(
  high: readonly Finding[],
  blockedKeys: readonly string[],
  isStopHookActive: boolean,
): { readonly shouldBlock: boolean; readonly keys: readonly string[] } {
  const keys = high.map((finding) => finding.key).toSorted()
  if (isStopHookActive) return { shouldBlock: false, keys }
  const blocked = new Set(blockedKeys)
  return { shouldBlock: keys.some((key) => !blocked.has(key)), keys }
}
