import { atLeast, type Finding, type Severity } from './types.ts'

/** まだ知らせていない、指定の重さ以上の指摘。 */
export function unseen(findings: readonly Finding[], seenKeys: readonly string[], min: Severity): readonly Finding[] {
  const seen = new Set(seenKeys)
  return findings.filter(atLeast(min)).filter((finding) => !seen.has(finding.key))
}

/**
 * 知らせた指紋を覚える。今ある指摘の指紋だけを残すので、直ってから再び起きた指摘はまた知らせる。
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
 * ターンの終わりを止めるか。止めるのは、止めたことのない高い指摘があるときだけで、
 * Stop フックで続いているターン (stop_hook_active) では止めない。
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
