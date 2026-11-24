import { execFileSync } from 'node:child_process'
import type { Notifier } from '../../ports/index.ts'

const TIMEOUT_MS = 10_000

/**
 * The body and title are passed as AppleScript arguments (argv). They are not embedded in the script string, so even if an issue's title has quotes or
 * newlines, it is not read as script. No `sound name` is attached, so no sound plays.
 */
export function osascriptArgs(title: string, body: string): readonly string[] {
  return ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', '--', body, title]
}

/** Shows a macOS notification. Throws on failure. Does nothing outside macOS. */
export const macosNotify: Notifier = (title, body) => {
  if (process.platform !== 'darwin') return
  execFileSync('osascript', [...osascriptArgs(title, body)], { timeout: TIMEOUT_MS, stdio: 'ignore' })
}
