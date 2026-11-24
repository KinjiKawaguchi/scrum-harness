import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from './config.ts'

export type Paths = ReturnType<typeof paths>

/** 状態のディレクトリ (~/.claude/scrum) の中の置き場所。 */
export function paths(dir: string = stateDir()) {
  return {
    dir,
    snapshot: join(dir, 'cache', 'board.json'),
    /** 最後に取り直して取れた控えの写し。取り直しだけが書く (フックや dispatch が Status を直して board.json を書き換えても、これは変わらない) */
    fetchedSnapshot: join(dir, 'cache', 'board-fetched.json'),
    refreshLock: join(dir, 'cache', 'refresh.lock'),
    /** bin/scrum が node を起こすかを決める型 (1行目: ツールの後、2行目: 書き込みの前)。設定から作る */
    shellPatterns: join(dir, 'cache', 'shell-patterns'),
    /** 前に取り直しを試した時刻。失敗が続いても、試すのは refreshSeconds に1回にする */
    refreshAttempt: join(dir, 'cache', 'refresh-attempt.json'),
    heartbeats: join(dir, 'team'),
    identity: join(dir, 'identity'),
    acks: join(dir, 'acks.json'),
    notified: join(dir, 'notify', 'notified.json'),
    blocked: join(dir, 'notify', 'blocked.json'),
    /** 待機プロセスが置く印。TechLead の作業中に、知らせていない指摘があることを bin/scrum に伝える */
    pending: join(dir, 'notify', 'pending'),
    watchLock: join(dir, 'watch.lock'),
    events: join(dir, 'log', 'events.jsonl'),
    /** 節目の記録 (1行1節目) */
    checkpoints: join(dir, 'log', 'checkpoints.jsonl'),
    /** 済んだ issue の、ポイントと実際にかかった節目の記録 (1行1件) */
    completions: join(dir, 'log', 'completions.jsonl'),
    checkpointLock: join(dir, 'cache', 'checkpoint.lock'),
    errors: join(dir, 'log', 'errors.log'),
    metricsState: join(dir, 'log', 'metrics-state.json'),
    /** 空いた部下に渡した仕事の記録 (1行1件) */
    dispatches: join(dir, 'log', 'dispatches.jsonl'),
    /** 渡す仕事を決めて書き込む間の錠。同じ issue を 2 人に渡さないため */
    dispatchLock: join(dir, 'cache', 'dispatch.lock'),
    /** 部下ごと、issue ごとに、最後に見た作業の印と、印が変わった時刻。進んでいる間は促さず、A-NUDGE-IGNORED が促しと同じ印で判断するため */
    dispatchSeen: join(dir, 'cache', 'dispatch-seen.json'),
    /** 渡すのに失敗した時刻。失敗が続いても、試すのは数分に1回にする */
    dispatchFailure: join(dir, 'cache', 'dispatch-failure.json'),
    /** PR を issue の本文に並べた最後の時刻。失敗が続いても、試すのは間隔ごとに 1 回にする */
    linksState: join(dir, 'cache', 'links-state.json'),
    /** PR を issue の本文に並べる間の錠 */
    linksLock: join(dir, 'cache', 'links.lock'),
    /** issue の本文を書き換える直前の、元の本文 (1 行 1 件)。人の直しを巻き戻せるように残す */
    linksBefore: join(dir, 'log', 'links-before.jsonl'),
    /** 止まりの検知の状態 (動く人がいない Epic、渡せる issue が無い部下、通知を出した指紋) */
    alertsState: join(dir, 'cache', 'alerts-state.json'),
    /** 検知の状態を読み、直して書く間の錠。待機プロセスが重ねて通知しないため */
    alertsLock: join(dir, 'cache', 'alerts.lock'),
    /** 部下ごとの待機プロセスの錠 */
    memberWatchLock: (name: string) => join(dir, 'cache', `dispatch-watch-${name}.lock`),
  }
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 一時ファイルに書いてから置き換え、読む側が書きかけを見ないようにする。 */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`)
  renameSync(tmp, path)
}

export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${line}\n`)
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** pid を書いた錠。持ち主が生きていれば取れない。持ち主が死んでいれば取り直す。 */
export function tryLock(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    const owner = Number(readFileSync(path, 'utf8'))
    if (owner === process.pid) return true
    if (Number.isInteger(owner) && owner > 0 && isPidAlive(owner)) return false
    writeFileSync(path, String(process.pid))
    return true
  }
}

export function releaseLock(path: string): void {
  try {
    if (Number(readFileSync(path, 'utf8')) === process.pid) rmSync(path)
  } catch {
    // 錠が無ければ何もしない
  }
}

/**
 * 外のコマンド (gh) の失敗は、Error の文に長い問い合わせの文がまるごと入り、原因が切り落とされる。
 * stderr を持つ失敗は、終了コードと stderr を残す。
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const { status, stderr } = error as Error & { readonly status?: unknown; readonly stderr?: unknown }
  const text = typeof stderr === 'string' ? stderr : stderr instanceof Buffer ? stderr.toString('utf8') : ''
  if (text.trim() === '') return error.message
  return `gh が exit ${typeof status === 'number' ? status : '?'}: ${text.trim().replace(/\s+/g, ' ')}`
}

export function logError(p: Paths, where: string, error: unknown): void {
  appendLine(p.errors, `${new Date().toISOString()} ${where}: ${describeError(error).slice(0, 1000)}`)
}
