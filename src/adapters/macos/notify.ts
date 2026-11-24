import { execFileSync } from 'node:child_process'
import type { Notifier } from '../../ports/index.ts'

const TIMEOUT_MS = 10_000

/**
 * 本文と題は AppleScript の引数 (argv) で渡す。スクリプトの文字列に埋め込まないので、issue の題に引用符や
 * 改行があっても、スクリプトとして読まれない。`sound name` を付けないので、音は鳴らない。
 */
export function osascriptArgs(title: string, body: string): readonly string[] {
  return ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', '--', body, title]
}

/** macOS の通知を出す。失敗したら投げる。macOS 以外では何もしない。 */
export const macosNotify: Notifier = (title, body) => {
  if (process.platform !== 'darwin') return
  execFileSync('osascript', [...osascriptArgs(title, body)], { timeout: TIMEOUT_MS, stdio: 'ignore' })
}
