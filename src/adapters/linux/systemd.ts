import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ScheduledJob, ScheduleFile, Scheduler, ScheduleSetup } from '../../ports/index.ts'
import { realRun, runOrThrow, type Run } from '../run.ts'

/** The unit name without the suffix: `scrum-harness-alerts`, or `scrum-harness-<instance>-alerts`. */
export const unitOf = (job: ScheduledJob, setup: ScheduleSetup): string => `scrum-harness-${setup.instance === '' ? '' : `${setup.instance}-`}${job.name}`

/** A word of an Exec line: quoted, with the characters systemd reads specially escaped (`%` for specifiers, `$` for variables). */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`
}

/** A value of an Environment line: quoted. Only `%` is special there, not `$`. */
const quoteEnv = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`

/** A path setting reads the whole line, so spaces need no quotes; only `%` is escaped. */
const pathValue = (value: string): string => value.replace(/%/g, '%%')

const logOf = (job: ScheduledJob, setup: ScheduleSetup): string => join(setup.stateDir, 'log', `${job.name}-systemd.log`)

export function serviceOf(job: ScheduledJob, setup: ScheduleSetup): string {
  const env = [`PATH=${setup.path}`, ...(setup.isCustomStateDir ? [`SCRUM_STATE_DIR=${setup.stateDir}`] : [])]
  const exec = [join(setup.scrumDir, 'bin', 'scrum'), ...job.args].map(quote).join(' ')
  const log = `append:${pathValue(logOf(job, setup))}`
  return `[Unit]
Description=scrum-harness ${job.name}${setup.instance === '' ? '' : ` (${setup.instance})`}

[Service]
Type=oneshot
WorkingDirectory=${pathValue(setup.scrumDir)}
${env.map((entry) => `Environment=${quoteEnv(entry)}`).join('\n')}
ExecStart=${exec}
UMask=0077
Nice=10
IOSchedulingClass=idle
StandardOutput=${log}
StandardError=${log}
`
}

export function timerOf(job: ScheduledJob, setup: ScheduleSetup): string {
  return `[Unit]
Description=Run scrum-harness ${job.name}${setup.instance === '' ? '' : ` (${setup.instance})`} every ${job.everySeconds} seconds

[Timer]
OnActiveSec=${job.everySeconds}s
OnUnitActiveSec=${job.everySeconds}s
AccuracySec=30s

[Install]
WantedBy=timers.target
`
}

/** Where a user's unit files go: $XDG_CONFIG_HOME/systemd/user, else ~/.config/systemd/user. */
export const unitDir = (home: string, xdgConfigHome: string | undefined): string => join(xdgConfigHome !== undefined && xdgConfigHome !== '' ? xdgConfigHome : join(home, '.config'), 'systemd', 'user')

/**
 * Runs the job as a systemd user timer and service. `run` and the config home are replaced in tests.
 * For the timer to run while nobody is logged in, the user needs `loginctl enable-linger`.
 */
export function systemdScheduler(run: Run = realRun, xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME): Scheduler {
  const systemctl = (args: readonly string[]) => runOrThrow(run, 'systemctl', ['--user', ...args])
  const files = (job: ScheduledJob, setup: ScheduleSetup): readonly ScheduleFile[] => {
    const dir = unitDir(setup.home, xdgConfigHome)
    return [
      { path: join(dir, `${unitOf(job, setup)}.service`), content: serviceOf(job, setup) },
      { path: join(dir, `${unitOf(job, setup)}.timer`), content: timerOf(job, setup) },
    ]
  }
  return {
    kind: 'systemd',
    files,
    install: (job, setup) => {
      const written = files(job, setup)
      mkdirSync(dirname(logOf(job, setup)), { recursive: true })
      for (const file of written) {
        mkdirSync(dirname(file.path), { recursive: true })
        writeFileSync(file.path, file.content)
      }
      systemctl(['daemon-reload'])
      systemctl(['enable', '--now', `${unitOf(job, setup)}.timer`])
      return [
        `Installed ${written.map((file) => file.path).join(' and ')} and started the timer. Check: scrum schedule status${setup.instance === '' ? '' : ` --name ${setup.instance}`}; the log is ${logOf(job, setup)}`,
        'To keep it running while you are logged out: loginctl enable-linger "$USER"',
      ].join('\n')
    },
    uninstall: (job, setup) => {
      const disabled = run('systemctl', ['--user', 'disable', '--now', `${unitOf(job, setup)}.timer`])
      for (const file of files(job, setup)) rmSync(file.path, { force: true })
      run('systemctl', ['--user', 'daemon-reload'])
      return disabled.status === 0 ? `Removed ${unitOf(job, setup)}` : `Removed the files; systemd did not know the timer (${disabled.stderr.trim()})`
    },
    status: (job, setup) => {
      const timer = `${unitOf(job, setup)}.timer`
      const active = run('systemctl', ['--user', 'is-active', timer])
      if (active.status !== 0) return `${timer} is ${active.stdout.trim() || 'not installed'}`
      const listed = run('systemctl', ['--user', 'list-timers', timer, '--no-pager'])
      const last = run('systemctl', ['--user', 'show', `${unitOf(job, setup)}.service`, '-p', 'Result', '-p', 'ExecMainStatus'])
      return [`${timer} is active`, listed.stdout.trim(), last.stdout.trim()].filter((part) => part !== '').join('\n')
    },
  }
}
