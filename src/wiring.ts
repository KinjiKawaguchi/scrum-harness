import { claudeCodeSessions } from './adapters/claude-code/sessions.ts'
import { githubPorts } from './adapters/github/index.ts'
import { macosNotify } from './adapters/macos/notify.ts'
import type { Config } from './config.ts'
import type { Ports } from './ports/index.ts'

/**
 * 設定から、中心に渡すポートを組み立てる。中心のコードはアダプタを import せず、ここで作ったものだけを受け取る。
 * ボードとコードは GitHub、セッションは Claude Code、通知は macOS。
 */
export function buildPorts(config: Config): Ports {
  return { ...githubPorts(config), sessions: claudeCodeSessions(), notify: macosNotify }
}

