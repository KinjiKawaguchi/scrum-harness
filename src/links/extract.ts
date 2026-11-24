import type { LinksConfig } from './config.ts'

/** The items to count among open PRs. */
export type OpenPr = {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly headRefName: string
  readonly author: string
}

/** `#N` (one preceded by a word character, such as repo#N and owner/repo#N, or a character reference such as &#123;, is not read, because it is another repository's issue or a character reference). */
const HASH_REFERENCE = /(?<![\w#&])#(\d+)\b/g
/** The leading number in a branch name (feat/456-ci, 456-foo). The number is followed by a separator (- _ /) or the end. */
const BRANCH_NUMBER = /^(?:[a-z]+\/)?(\d+)(?:[-_/]|$)/
/** The `#N` in parentheses in a title (`feat: x (#123)`, `(#123, #124)`). */
const TITLE_PARENTHESES = /\(([^)]*)\)/g
/** A line of the body that starts with a word pointing at an issue (Closes, Fixes, Resolves, Refs, and their inflections). */
const REFERENCE_LINE = /^\s*(?:[-*]\s*)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b:?\s+(.*)$/i

function numbersIn(text: string): readonly number[] {
  return [...text.matchAll(HASH_REFERENCE)].map((match) => Number(match[1]))
}

/** Lines outside code fences (```). */
function linesOutsideFences(body: string): readonly string[] {
  let inFence = false
  return body.split(/\r?\n/).filter((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return false
    }
    return !inFence
  })
}

/**
 * The issue numbers a PR points at. Only the following 3 are read (a `#N` elsewhere in the body is not read; it is a number written for context, and one PR would line up under many issues).
 *   - the `#N` in parentheses in the title
 *   - the leading number of the branch name
 *   - the `#N` on a body line starting with Closes, Fixes, Resolves, or Refs
 * The PR's own number is excluded. No duplicates, in ascending order.
 */
export function referencedNumbers(pr: OpenPr): readonly number[] {
  const fromTitle = [...pr.title.matchAll(TITLE_PARENTHESES)].flatMap((match) => numbersIn(match[1] ?? ''))
  const fromBody = linesOutsideFences(pr.body).flatMap((line) => numbersIn(REFERENCE_LINE.exec(line)?.[1] ?? ''))
  const branch = BRANCH_NUMBER.exec(pr.headRefName)
  const numbers = [...fromTitle, ...fromBody, ...(branch === null ? [] : [Number(branch[1])])]
  return [...new Set(numbers)].filter((number) => number !== pr.number).toSorted((a, b) => a - b)
}

/** Whether a PR is not counted (Dependabot's author, release/ or sync/ branches). */
export function isSkipped(pr: OpenPr, links: LinksConfig): boolean {
  return links.skipAuthors.includes(pr.author) || links.skipBranchPrefixes.some((prefix) => pr.headRefName.startsWith(prefix))
}
