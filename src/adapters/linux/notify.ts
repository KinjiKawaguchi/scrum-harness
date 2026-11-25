import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Notifier } from '../../ports/index.ts'
import { realRun, type Run } from '../run.ts'

/** notify-send takes the text as arguments after `--`, so a title that starts with a dash is not read as an option. */
export function notifySendArgs(title: string, body: string): readonly string[] {
  return ['--app-name=scrum-harness', '--', title, body]
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Shows a desktop notification with `notify-send` when it is installed and a desktop session is reachable. Otherwise
 * (a server with no desktop, a timer with no session bus) it appends one line to the log file, so the notice is not lost.
 * It never throws because of a missing notifier; only a log file that cannot be written throws.
 */
export function linuxNotifier(logPath: string, run: Run = realRun, now: () => Date = () => new Date()): Notifier {
  return (title, body) => {
    const shown = run('notify-send', notifySendArgs(title, body))
    if (shown.status === 0) return
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${now().toISOString()}\t${oneLine(title)}\t${oneLine(body)}\n`)
  }
}
