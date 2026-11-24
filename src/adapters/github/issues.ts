import type { IssueBody, IssueComment, IssueThread } from '../../ports/index.ts'
import type { GhRun } from './gh.ts'
import { parseList } from './parse-list.ts'

/** issue のコメントを読む。 */
export function fetchIssueComments(repo: string, number: number, run: GhRun): readonly IssueComment[] {
  const raw = JSON.parse(run(['issue', 'view', String(number), '-R', repo, '--json', 'comments'])) as {
    readonly comments?: readonly { readonly body?: string; readonly createdAt?: string; readonly url?: string }[]
  }
  return (raw.comments ?? []).flatMap((one): readonly IssueComment[] =>
    typeof one.body === 'string' && typeof one.createdAt === 'string' ? [{ body: one.body, createdAt: one.createdAt, ...(one.url === undefined ? {} : { url: one.url }) }] : [],
  )
}

export function listOpenIssues(run: GhRun, repo: string): readonly IssueBody[] {
  const output = run(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '1000', '--json', 'number,body'])
  return parseList(output, (record) => (typeof record.number === 'number' ? { number: record.number, body: typeof record.body === 'string' ? record.body : '' } : null))
}

/** いまの issue の状態 (open か closed) と本文。 */
function readIssue(run: GhRun, repo: string, number: number): { readonly isOpen: boolean; readonly body: string } {
  const issue = JSON.parse(run(['api', `repos/${repo}/issues/${number}`])) as { state?: unknown; body?: unknown }
  return { isOpen: issue.state === 'open', body: typeof issue.body === 'string' ? issue.body : '' }
}

/** 本文は -f で渡す (-F だと、@ で始まる本文がファイルとして読まれる)。 */
function writeIssueBody(run: GhRun, repo: string, number: number, body: string): void {
  run(['api', '-X', 'PATCH', `repos/${repo}/issues/${number}`, '-f', `body=${body}`])
}

export function githubIssueThread(run: GhRun): IssueThread {
  return {
    comments: (item) => {
      if (item.number === null) throw new Error('番号の無い項目のコメントは読めない')
      return fetchIssueComments(item.repo, item.number, run)
    },
    openIssues: (repo) => listOpenIssues(run, repo),
    read: (repo, number) => readIssue(run, repo, number),
    writeBody: (repo, number, body) => writeIssueBody(run, repo, number, body),
  }
}
