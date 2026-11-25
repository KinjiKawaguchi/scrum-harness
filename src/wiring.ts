import { claudeCodeSessions } from './adapters/claude-code/sessions.ts'
import { claudeCodeTranscripts } from './adapters/claude-code/transcripts.ts'
import { githubPorts } from './adapters/github/index.ts'
import { macosNotify } from './adapters/macos/notify.ts'
import type { Config } from './config.ts'
import type { Ports } from './ports/index.ts'

/**
 * Builds, from the config, the ports handed to the core. The core code does not import adapters and receives only what is built here.
 * The board and code are GitHub, sessions and transcripts are Claude Code, and notifications are macOS.
 */
export function buildPorts(config: Config): Ports {
  return { ...githubPorts(config), sessions: claudeCodeSessions(), transcripts: claudeCodeTranscripts(), notify: macosNotify }
}

