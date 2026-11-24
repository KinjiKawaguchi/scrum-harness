import { shortRepo } from '../../config.ts'
import type { OpenPr } from '../../links/extract.ts'
import type { GhRun } from './gh.ts'
import { parseList } from './parse-list.ts'

export function listOpenPrs(run: GhRun, repo: string): readonly OpenPr[] {
  const output = run(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '300', '--json', 'number,title,body,headRefName,author'])
  return parseList(output, (record) =>
    typeof record.number === 'number' && typeof record.title === 'string' && typeof record.headRefName === 'string'
      ? { number: record.number, title: record.title, body: typeof record.body === 'string' ? record.body : '', headRefName: record.headRefName, author: String(record.author?.login ?? '') }
      : null,
  )
}

/** The PR body. null if it cannot be fetched. The label has the form "<repository name>#123", and repo is the full name. */
export function fetchPrBody(run: GhRun, prLabel: string, repo: string): string | null {
  const number = prLabel.split('#')[1] ?? ''
  try {
    return run(['pr', 'view', number, '-R', repo, '--json', 'body', '--jq', '.body'])
  } catch {
    return null
  }
}

const REFERENCE = /(?<![\w/.#-])(?:([A-Za-z0-9_.-]+)#|#)(\d+)/g

/** Picks up mentions of issues (#number, repository name#number) from the PR body. */
export function referencedLabels(body: string, repo: string): readonly string[] {
  const labels = [...body.matchAll(REFERENCE)].map((match) => `${match[1] ?? shortRepo(repo)}#${match[2]}`)
  return [...new Set(labels)]
}
