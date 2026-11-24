import type { IssueBody, IssueComment, IssueThread } from '../../ports/index.ts'
import type { GhRun } from './gh.ts'
import { parseList } from './parse-list.ts'

/** Reads an issue's comments. */
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

/** The issue's current state (open or closed) and body. */
function readIssue(run: GhRun, repo: string, number: number): { readonly isOpen: boolean; readonly body: string } {
  const issue = JSON.parse(run(['api', `repos/${repo}/issues/${number}`])) as { state?: unknown; body?: unknown }
  return { isOpen: issue.state === 'open', body: typeof issue.body === 'string' ? issue.body : '' }
}

/** The body is passed with -f (with -F, a body starting with @ would be read as a file). */
function writeIssueBody(run: GhRun, repo: string, number: number, body: string): void {
  run(['api', '-X', 'PATCH', `repos/${repo}/issues/${number}`, '-f', `body=${body}`])
}

/** The body is passed with -f so that a body starting with @ is not read as a file. */
function postComment(run: GhRun, repo: string, number: number, body: string): void {
  run(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`])
}

export function githubIssueThread(run: GhRun): IssueThread {
  return {
    comments: (item) => {
      if (item.number === null) throw new Error('cannot read the comments of an item without a number')
      return fetchIssueComments(item.repo, item.number, run)
    },
    openIssues: (repo) => listOpenIssues(run, repo),
    read: (repo, number) => readIssue(run, repo, number),
    writeBody: (repo, number, body) => writeIssueBody(run, repo, number, body),
    addComment: (repo, number, body) => postComment(run, repo, number, body),
  }
}
