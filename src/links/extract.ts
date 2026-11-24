import type { LinksConfig } from './config.ts'

/** 開いている PR のうち、数える項目。 */
export type OpenPr = {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly headRefName: string
  readonly author: string
}

/** `#N` (repo#N、owner/repo#N、&#123; のような文字参照は、別の issue か文字参照なので読まない)。 */
const HASH_REFERENCE = /(?<![\w#&])#(\d+)\b/g
/** ブランチ名の先頭の番号 (feat/456-ci、456-foo)。番号の後ろは、区切り (- _ /) か終わり。 */
const BRANCH_NUMBER = /^(?:[a-z]+\/)?(\d+)(?:[-_/]|$)/
/** 題の括弧の中の `#N` (`feat: x (#123)`、`(#123、#124)`)。 */
const TITLE_PARENTHESES = /\(([^)]*)\)/g
/** 本文の、issue を指す語で始まる行 (Closes、Fixes、Resolves、Refs と、その活用)。 */
const REFERENCE_LINE = /^\s*(?:[-*]\s*)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b:?\s+(.*)$/i

function numbersIn(text: string): readonly number[] {
  return [...text.matchAll(HASH_REFERENCE)].map((match) => Number(match[1]))
}

/** コードの囲み (```) の外の行。 */
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
 * PR が指す issue の番号。次の 3 つだけを読む (本文のどこかの `#N` は読まない。文脈のために書いた番号で、1 つの PR が何本もの issue に並ぶため)。
 *   - 題の括弧の中の `#N`
 *   - ブランチ名の先頭の番号
 *   - 本文の、Closes、Fixes、Resolves、Refs で始まる行の `#N`
 * 自分の PR の番号は除く。重複なしで、小さい順。
 */
export function referencedNumbers(pr: OpenPr): readonly number[] {
  const fromTitle = [...pr.title.matchAll(TITLE_PARENTHESES)].flatMap((match) => numbersIn(match[1] ?? ''))
  const fromBody = linesOutsideFences(pr.body).flatMap((line) => numbersIn(REFERENCE_LINE.exec(line)?.[1] ?? ''))
  const branch = BRANCH_NUMBER.exec(pr.headRefName)
  const numbers = [...fromTitle, ...fromBody, ...(branch === null ? [] : [Number(branch[1])])]
  return [...new Set(numbers)].filter((number) => number !== pr.number).toSorted((a, b) => a - b)
}

/** 数えない PR か (Dependabot の作者、release/ や sync/ のブランチ)。 */
export function isSkipped(pr: OpenPr, links: LinksConfig): boolean {
  return links.skipAuthors.includes(pr.author) || links.skipBranchPrefixes.some((prefix) => pr.headRefName.startsWith(prefix))
}
