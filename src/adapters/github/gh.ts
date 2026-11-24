import { execFileSync } from 'node:child_process'

/** gh を呼び、標準出力を返す。失敗すれば投げる。試験では、同じ形の偽物を渡す。 */
export type GhRun = (args: readonly string[]) => string

/**
 * 標準エラーは、親に流さず、投げる例外に持たせる。流すと、待機プロセスが起こす文 (asyncRewake は stderr を文として読む) に、
 * gh の失敗の文が混ざる。
 */
const GH_STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']

function runGh(args: readonly string[], timeoutMs: number): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, stdio: GH_STDIO })
}

/** gh を呼び、標準出力を返す。失敗すれば投げる。 */
export function gh(args: readonly string[]): string {
  return runGh(args, 120_000)
}

/** 時間を絞った gh。錠を持ったまま呼ぶ所で使う (遅い呼び出しが、ほかの人の渡しを待たせないため)。 */
export function ghWithin(timeoutMs: number): GhRun {
  return (args) => runGh(args, timeoutMs)
}
