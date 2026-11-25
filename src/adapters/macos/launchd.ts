import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ScheduledJob, Scheduler, ScheduleSetup } from '../../ports/index.ts'
import { realRun, runOrThrow, type Run } from '../run.ts'

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const labelOf = (job: ScheduledJob, setup: ScheduleSetup): string => `local.scrum-harness.${setup.instance === '' ? '' : `${setup.instance}.`}${job.name}`

const logOf = (job: ScheduledJob, setup: ScheduleSetup): string => join(setup.stateDir, 'log', `${job.name}-launchd.log`)

/** The launch agent that runs the job: no login shell is inherited, so PATH is written in. launchd's Umask 63 is 0077. */
export function plistOf(job: ScheduledJob, setup: ScheduleSetup): string {
  const env = [['PATH', setup.path], ...(setup.isCustomStateDir ? [['SCRUM_STATE_DIR', setup.stateDir]] : [])] as const
  const entries = env.map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>\n`).join('')
  const args = [join(setup.scrumDir, 'bin', 'scrum'), ...job.args].map((arg) => `\t\t<string>${xml(arg)}</string>\n`).join('')
  const log = xml(logOf(job, setup))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(labelOf(job, setup))}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(setup.scrumDir)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${entries}\t</dict>
\t<key>StartInterval</key>
\t<integer>${job.everySeconds}</integer>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>Umask</key>
\t<integer>63</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>Nice</key>
\t<integer>10</integer>
\t<key>LowPriorityIO</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${log}</string>
\t<key>StandardErrorPath</key>
\t<string>${log}</string>
</dict>
</plist>
`
}

const plistPath = (job: ScheduledJob, setup: ScheduleSetup): string => join(setup.home, 'Library', 'LaunchAgents', `${labelOf(job, setup)}.plist`)

/** Runs the job as a launchd launch agent of the logged-in user. `run` and `uid` are replaced in tests. */
export function launchdScheduler(run: Run = realRun, uid: number = process.getuid?.() ?? 0): Scheduler {
  const domain = `gui/${uid}`
  return {
    kind: 'launchd',
    files: (job, setup) => [{ path: plistPath(job, setup), content: plistOf(job, setup) }],
    install: (job, setup) => {
      const path = plistPath(job, setup)
      mkdirSync(dirname(path), { recursive: true })
      mkdirSync(dirname(logOf(job, setup)), { recursive: true })
      writeFileSync(path, plistOf(job, setup))
      runOrThrow(run, 'launchctl', ['bootstrap', domain, path])
      runOrThrow(run, 'launchctl', ['kickstart', '-k', `${domain}/${labelOf(job, setup)}`])
      return `Installed ${path} and ran it once. Check: scrum schedule status${setup.instance === '' ? '' : ` --name ${setup.instance}`}; the log is ${logOf(job, setup)}`
    },
    uninstall: (job, setup) => {
      const result = run('launchctl', ['bootout', `${domain}/${labelOf(job, setup)}`])
      rmSync(plistPath(job, setup), { force: true })
      return result.status === 0 ? `Removed ${labelOf(job, setup)}` : `Removed the file; launchd did not know ${labelOf(job, setup)} (${result.stderr.trim()})`
    },
    status: (job, setup) => {
      const printed = run('launchctl', ['print', `${domain}/${labelOf(job, setup)}`])
      if (printed.status !== 0) return `${labelOf(job, setup)} is not installed`
      return printed.stdout.split('\n').filter((line) => /\b(state|last exit code)\b/.test(line)).map((line) => line.trim()).join('\n')
    },
  }
}
