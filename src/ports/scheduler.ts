/** A command the system's scheduler runs again and again: `bin/scrum <args>` every `everySeconds`. */
export type ScheduledJob = {
  /** What the job does, as one word (`alerts`). It is part of the unit name. */
  readonly name: string
  /** The arguments after `bin/scrum` */
  readonly args: readonly string[]
  readonly everySeconds: number
}

/** The values of this machine and this team that a scheduler needs to write its files. */
export type ScheduleSetup = {
  readonly home: string
  /** Where the harness is checked out (the folder with `bin/scrum`) */
  readonly scrumDir: string
  /** The PATH the job runs with. The schedulers do not hand on the login shell's PATH. */
  readonly path: string
  readonly stateDir: string
  /** Set when the state directory is not the default one (`~/.claude/scrum`), so the job reads the same directory */
  readonly isCustomStateDir: boolean
  /** Tells the jobs of several teams on one machine apart. Empty for the only one. */
  readonly instance: string
}

export type ScheduleFile = { readonly path: string; readonly content: string }

/**
 * The system scheduler that runs the background loop (stall detection runs every 5 minutes, because the watch process lives shorter than its limit).
 * `files` is pure, so the text can be checked and shown without installing anything. The other methods act on the system and return what to tell the user.
 */
export type Scheduler = {
  readonly kind: 'launchd' | 'systemd'
  readonly files: (job: ScheduledJob, setup: ScheduleSetup) => readonly ScheduleFile[]
  readonly install: (job: ScheduledJob, setup: ScheduleSetup) => string
  readonly uninstall: (job: ScheduledJob, setup: ScheduleSetup) => string
  readonly status: (job: ScheduledJob, setup: ScheduleSetup) => string
}
