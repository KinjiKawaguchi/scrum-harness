import { isRefreshDue, refreshSnapshot } from './board/snapshot.ts'
import {
  ackCommand,
  checkpointCommand,
  pointsCommand,
  acksCommand,
  installCommand,
  lintCommand,
  parseFlags,
  reportCommand,
  statuslineCommand,
  teamCommand,
  writeShellPatterns,
} from './cli-commands.ts'
import { alertsCommand } from './alerts/command.ts'
import { configPath, dispatchOf, loadConfig, type Config } from './config.ts'
import { dispatchOnce, formatOnce } from './dispatch/once.ts'
import { handleHook } from './hooks/handlers.ts'
import { linkPullRequests, type LinkPlan } from './links/run.ts'
import { hookDeps, parseInput, readStdin, spawnRefresh } from './runtime.ts'
import { logError, paths, type Paths } from './store.ts'
import { resolveIdentity } from './team/identity.ts'
import type { Ports } from './ports/index.ts'
import { watchFor } from './watch-role.ts'
import { buildPorts } from './wiring.ts'
import { runRuntime } from './agency-runtime/handle.ts'

const USAGE = `scrum: GitHub Project のボードと部下の稼働を点検する
  scrum lint [--refresh] [--json]   指摘の全件
  scrum team                        TechLead と部下の稼働
  scrum refresh                     ボードを取り直す
  scrum ack <規則> <対象> (--for 2h | --until <時刻>) --reason "<理由>"
                                    T-IDLE は最長 1 時間で、理由は「<オーナー>の答え待ち」か「枠 HH:MM」
  scrum acks                        受け入れ済みの例外
  scrum report [--since YYYY-MM-DD] スプリントレビュー用のまとめ
  scrum points                      作業中の issue のポイント・目安・手間・超過
  scrum link-prs [--dry-run]        開いている PR を、指す issue の本文の、印の間に並べる (links.enabled のときの待機も流す。--dry-run は予定だけ)
  scrum alerts                      止まりの検知 (E-STALL、Q-EMPTY) を 1 回進める。launchd が 5 分ごとに流す (launchd/)
  scrum dispatch --once [<名前>...] 空いている部下に、1 回だけ、次の仕事を選んでボードに書き、送る文を出す (dispatch を有効にした直後の、すでに空いている部下のため)
  scrum checkpoint                  まだ記録していない節目を、今記録する (待機プロセスも自動で記録する)
  scrum statusline                  statusline 用の短い表示 (stdin に statusline の JSON)
  scrum install | uninstall         ~/.claude/settings.json にフックを足す・外す
  scrum hook <Event> | watch        Claude Code のフックから呼ぶ`

function identityOf(p: Paths, input: Record<string, unknown>, now: Date, config: Config, ports: Ports) {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  return sessionId === '' ? null : resolveIdentity(p, sessionId, now, config, ports.sessions)
}

/** フックは失敗してもセッションを止めない。エラーは記録だけして exit 0。 */
async function runHook(p: Paths, event: string): Promise<number> {
  const config = loadConfig()
  if (config === null) return 0
  try {
    const input = parseInput(await readStdin())
    const now = new Date()
    const ports = buildPorts(config)
    const result = handleHook(event, input, hookDeps(p, config, identityOf(p, input, now, config, ports), now, ports))
    if (result.stdout !== undefined) process.stdout.write(JSON.stringify(result.stdout))
  } catch (error) {
    logError(p, `hook ${event}`, error)
  }
  return 0
}

const WATCH_MAX_MS = 50 * 60_000
const WATCH_INTERVAL_MS = 30_000

/**
 * TechLead は指摘を待ち、部下は dispatch が有効なときだけ、次の仕事を渡される時を待つ。
 * 窓口は alerts が有効なときだけ、止まりの検知が決めた通知の文を待つ。
 * 起こすときは stderr に文を書いて exit 2 (asyncRewake)。
 */
async function runWatchCommand(p: Paths): Promise<number> {
  const config = loadConfig()
  if (config === null) return 0
  const input = parseInput(await readStdin())
  const ports = buildPorts(config)
  const identity = identityOf(p, input, new Date(), config, ports)
  if (identity === null) return 0
  const message = await watchFor(p, config, identity.name, { maxMs: WATCH_MAX_MS, intervalMs: WATCH_INTERVAL_MS }, ports)
  if (message === null) return 0
  process.stderr.write(message)
  return 2
}

/** agency-runtime/1: one JSON request on stdin, one JSON response on stdout, exit 0 for a result and 1 for an error. */
async function runRuntimeCommand(p: Paths, config: Config | null, ports: Ports | null): Promise<number> {
  const deps = config === null || ports === null ? null : { p, config, now: new Date(), ports, spawnRefresh }
  const output = runRuntime(await readStdin(), deps)
  process.stdout.write(output.stdout)
  return output.exitCode
}

async function main(argv: readonly string[]): Promise<number> {
  const p = paths()
  const [command = 'help', ...rest] = argv
  const { positional, flags } = parseFlags(rest)
  const print = (text: string) => {
    if (text !== '') process.stdout.write(`${text}\n`)
    return 0
  }
  const config = loadConfig()
  const ports = config === null ? null : buildPorts(config)
  if (command === 'runtime') return runRuntimeCommand(p, config, ports)
  if (config !== null && ports !== null) writeShellPatterns(p, config, ports.actions)
  const needConfig = (run: (config: Config, ports: Ports) => string) =>
    print(config === null || ports === null ? `設定が無いか、欠けた値がある: ${configPath()} (config.example.json を写して直す)` : run(config, ports))
  switch (command) {
    case 'hook':
      return runHook(p, positional[0] ?? '')
    case 'watch':
      return runWatchCommand(p)
    case 'refresh': {
      return needConfig((c, ports) => {
        const snapshot = refreshSnapshot(p, c, new Date(), ports.board)
        return snapshot === null ? `取り直せなかった (ほかで取り直し中か、エラー。${p.errors})` : `${snapshot.items.length} 項目を取り直した`
      })
    }
    case 'lint':
      return needConfig((c, ports) => lintCommand(p, c, flags, ports))
    case 'team':
      return needConfig((c, ports) => teamCommand(p, c, ports.sessions))
    case 'ack':
      return print(ackCommand(p, positional, flags, config, new Date(), ports?.issues ?? null))
    case 'acks':
      return print(acksCommand(p))
    case 'report':
      return print(reportCommand(p, flags))
    case 'link-prs':
      return needConfig((c, ports) => {
        const result = linkPullRequests(p, c, new Date(), ports, { dryRun: flags['dry-run'] === true })
        const reasonOf = (plan: LinkPlan) => result.skipped.find((one) => one.plan === plan)?.reason
        const mark = (plan: LinkPlan) => (result.applied.includes(plan) ? ' (書き換えた)' : reasonOf(plan) === undefined ? '' : ` (飛ばした: ${reasonOf(plan)})`)
        const lines = result.planned.map((plan) => `${plan.repo}#${plan.issue}: ${plan.entries.map((entry) => `#${entry.number}`).join(' ') || '(印の組を消す)'}${mark(plan)}`)
        const broken = result.broken.map((one) => `${one.repo}#${one.issue}: 印が壊れている (片方だけ、2 組以上、順が逆)。書き換えない`)
        return [...lines, ...broken, `書き換える予定 ${result.planned.length} 件、書き換えた ${result.applied.length} 件、飛ばした ${result.skipped.length} 件、印が壊れている ${result.broken.length} 件`].join('\n')
      })
    case 'alerts':
      return needConfig((c, ports) => alertsCommand(p, c, new Date(), ports))
    case 'dispatch':
      return needConfig((c, ports) => {
        if (flags.once !== true) return '使い方: scrum dispatch --once [<名前>...]'
        const now = new Date()
        if (isRefreshDue(p, c, now)) refreshSnapshot(p, c, now, ports.board)
        return formatOnce(dispatchOnce(p, c, now, ports, positional))
      })
    case 'checkpoint':
      return needConfig((c, ports) => checkpointCommand(p, c, ports))
    case 'points':
      return needConfig((c) => pointsCommand(p, c))
    case 'statusline': {
      const input = parseInput(await readStdin())
      return config === null || ports === null ? 0 : print(statuslineCommand(p, config, input, ports.sessions))
    }
    case 'install':
    case 'uninstall':
      return print(installCommand(p, command === 'install'))
    default:
      return print(USAGE)
  }
}

process.exitCode = await main(process.argv.slice(2))
