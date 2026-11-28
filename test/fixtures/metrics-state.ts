import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A state directory for `scrum runtime` that has what `participantMetrics` reads, with times counted back from now so that the days it answers are recent:
 * two members, SWE1 and SWE2, that worked in two shifts (about a day apart), the tokens of those hours, and the pull requests you name with their authors.
 * Nothing in it comes from a real session. Make one with
 *
 *   node test/fixtures/metrics-state.ts --dir /tmp/metrics-state --repo acme/app --pr 12:SWE1 --pr 13:SWE2
 *
 * and ask it, as a node would (the runtime reads its state directory from SCRUM_STATE_DIR and takes the request on stdin):
 *
 *   echo '{"runtime":"agency-runtime/1","org":"acme","team":"app","op":"participantMetrics","days":14,"utcOffsetMinutes":540}' \
 *     | SCRUM_STATE_DIR=/tmp/metrics-state bin/scrum runtime
 *
 * The usage index is made current for a day after it is written, so the call never starts reading the real transcripts of the machine.
 */
export type MetricsStateOptions = {
  /** The repository the pull requests are in, as `owner/name` */
  readonly repo?: string
  /** Pull request number to the member that opened it */
  readonly pullRequests?: readonly { readonly number: number; readonly by: 'SWE1' | 'SWE2' }[]
  readonly now?: Date
}

const HOUR_MS = 3_600_000
const SESSIONS = { SWE1: '11111111-aaaa-4aaa-8aaa-111111111111', SWE2: '22222222-bbbb-4bbb-8bbb-222222222222' } as const
/** A process id that no machine has, so that the heartbeat files are of sessions that are gone */
const NO_SUCH_PID = 2_147_483_646

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const lines = (rows: readonly unknown[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join('')

/** One member's shifts: busy two hours, waiting half an hour, idle an hour and a half, then the session ends. `at` is when the shift begins, in hours before now. */
function shifts(name: keyof typeof SESSIONS, now: Date, startsHoursAgo: readonly number[]) {
  const sessionId = SESSIONS[name]
  const at = (hoursAgo: number): string => new Date(now.getTime() - hoursAgo * HOUR_MS).toISOString()
  return startsHoursAgo.flatMap((start) => [
    { at: at(start), sessionId, name, state: 'busy' },
    { at: at(start - 2), sessionId, name, state: 'waiting' },
    { at: at(start - 2.5), sessionId, name, state: 'idle' },
    { at: at(start - 4), sessionId, name, state: 'ended' },
  ])
}

export function writeMetricsState(dir: string, options: MetricsStateOptions = {}): void {
  // whole seconds, so that every shift is a whole number of seconds: with the milliseconds of the clock, a shift that crosses midnight is cut into two days that
  // each lose a fraction, and the totals miss a second at some times of day
  const given = options.now ?? new Date()
  const now = new Date(Math.floor(given.getTime() / 1000) * 1000)
  const repo = options.repo ?? 'acme/app'
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8')) as Record<string, unknown>
  write(join(dir, 'config.json'), `${JSON.stringify({ ...example, repos: [repo], defaultRepo: repo, techlead: 'TechLead', members: ['SWE1', 'SWE2'], runtime: { label: 'app', utcOffset: '+09:00' } }, null, 2)}\n`)

  const marks = [...shifts('SWE1', now, [33, 9]), ...shifts('SWE2', now, [32, 8])].toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
  write(join(dir, 'log', 'member-states.jsonl'), lines(marks))
  write(join(dir, 'log', 'member-states.since'), `${new Date(now.getTime() - 3 * 24 * HOUR_MS).toISOString()}\n`)
  for (const name of ['SWE1', 'SWE2'] as const) {
    const last = marks.filter((mark) => mark.name === name).at(-1)
    const at = last?.at ?? now.toISOString()
    write(join(dir, 'team', `${SESSIONS[name]}.json`), `${JSON.stringify({ sessionId: SESSIONS[name], name, state: 'ended', since: at, updatedAt: at, isAlive: false, nameSince: null, pid: NO_SUCH_PID, isLogged: true })}\n`)
    write(join(dir, 'identity', `${SESSIONS[name]}.json`), `${JSON.stringify({ name, pid: null, role: 'member', checkedAt: now.toISOString() })}\n`)
  }

  // A million input tokens in each busy hour: rows are [session, minute, model, fast, input, cache write 5m, cache write 1h, cache read, output].
  const rows = marks
    .filter((mark) => mark.state === 'busy')
    .flatMap((mark) => [0, 1].map((hour) => [mark.name === 'SWE1' ? 0 : 1, (Date.parse(mark.at) + hour * HOUR_MS) / 60_000, 0, 0, 1_000_000, 0, 0, 200_000, 50_000]))
  write(join(dir, 'cache', 'usage-index.json'), `${JSON.stringify({ version: 1, updatedAt: new Date(now.getTime() + 24 * HOUR_MS).toISOString(), files: {}, sessionIds: [SESSIONS.SWE1, SESSIONS.SWE2], models: ['claude-opus-5-5'], titles: {}, rows })}\n`)

  const authors = (options.pullRequests ?? []).map((one, i) => ({ at: new Date(now.getTime() - (i + 1) * HOUR_MS).toISOString(), name: one.by, sessionId: SESSIONS[one.by], ref: `${repo.split('/').pop()}#${one.number}`, repo, number: one.number }))
  write(join(dir, 'log', 'pr-authors.jsonl'), lines(authors))
}

function arg(argv: readonly string[], name: string): readonly string[] {
  return argv.flatMap((value, i) => (value === name && argv[i + 1] !== undefined ? [argv[i + 1] ?? ''] : []))
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const dir = arg(argv, '--dir')[0]
  if (dir === undefined) {
    process.stderr.write('usage: node test/fixtures/metrics-state.ts --dir <state dir> [--repo owner/name] [--pr <number>:<SWE1|SWE2>]...\n')
    process.exit(2)
  }
  const pullRequests = arg(argv, '--pr').flatMap((value): readonly { number: number; by: 'SWE1' | 'SWE2' }[] => {
    const [number, by] = value.split(':')
    return by === 'SWE1' || by === 'SWE2' ? [{ number: Number(number), by }] : []
  })
  const repo = arg(argv, '--repo')[0]
  writeMetricsState(dir, { ...(repo === undefined ? {} : { repo }), pullRequests })
  process.stdout.write(`wrote ${dir}\n`)
}
