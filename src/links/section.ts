export type PrEntry = { readonly number: number; readonly title: string }

/** 機械が書く範囲を囲む印。この間だけを書き換える。人が書いた見出しや節には触らない。 */
export const MARKER_START = '<!-- scrum-harness:prs -->'
export const MARKER_END = '<!-- /scrum-harness:prs -->'

const LABEL = 'PRs in progress (automatic)'
const TITLE_LIMIT = 60

/** 題の中の `(#N)` (や `(#N、#M)`) の括弧ごとと、残りの `#N` と `@` を除く。issue への言及や、メンションの通知を、足さないため。 */
function cleanTitle(title: string): string {
  return title
    .replace(/\s*\(\s*#\d+(?:\s*[,\u3001]\s*#\d+)*\s*\)/g, '')
    .replace(/#(\d+)/g, '$1')
    .replace(/@/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 題を TITLE_LIMIT 字までにする。切った所で開いた括弧は、閉じる (括弧の対を崩さない)。 */
export function describe(title: string): string {
  const clean = cleanTitle(title)
  if (clean.length <= TITLE_LIMIT) return clean
  const cut = clean.slice(0, TITLE_LIMIT)
  const open = [...cut].filter((char) => char === '(').length - [...cut].filter((char) => char === ')').length
  return `${cut}…${')'.repeat(Math.max(0, open))}`
}

/** `#<番号> (説明)` を ` / ` で並べた 1 行。 */
export function entryLine(entries: readonly PrEntry[]): string {
  return entries.map((entry) => `#${entry.number} (${describe(entry.title)})`).join(' / ')
}

/** 機械が書く範囲 (印の間と、印) の、本文の中の場所。 */
type Block = { readonly start: number; readonly end: number }

/** コードの囲み (```) の外の、行の頭の位置と、その行の文字列。 */
function linesOutsideFences(body: string): readonly { readonly offset: number; readonly text: string }[] {
  let inFence = false
  let offset = 0
  return body.split(/(?<=\n)/).flatMap((line) => {
    const here = offset
    offset += line.length
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return []
    }
    return inFence ? [] : [{ offset: here, text: line }]
  })
}

export type Located = { readonly kind: 'none' } | { readonly kind: 'found'; readonly block: Block } | { readonly kind: 'broken' }

/**
 * 印の組を探す。コードの囲みの中の印は数えない。両方が 1 つずつ、始まり、終わりの順であれば見つかった。
 * 片方しか無い、2 つ以上ある、順が逆なら、壊れている (書き換えない)。どちらも無ければ、無い。
 */
export function locateBlock(body: string): Located {
  const lines = linesOutsideFences(body)
  const starts = lines.filter((line) => line.text.trim() === MARKER_START)
  const ends = lines.filter((line) => line.text.trim() === MARKER_END)
  if (starts.length === 0 && ends.length === 0) return { kind: 'none' }
  const [start] = starts
  const [end] = ends
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end.offset <= start.offset) return { kind: 'broken' }
  return { kind: 'found', block: { start: start.offset, end: end.offset + end.text.trimEnd().length } }
}

function renderBlock(entries: readonly PrEntry[], eol: string): string {
  return `${MARKER_START}${eol}${LABEL}: ${entryLine(entries)}${eol}${MARKER_END}`
}

export type BodyUpdate = { readonly kind: 'updated'; readonly body: string } | { readonly kind: 'unchanged' } | { readonly kind: 'broken' }

/**
 * issue の本文の、印の間だけを、entries のとおりに書き換える。印の外は 1 文字も変えない。
 * 印が無ければ、本文の最後に足すだけ (今ある、人の「## 進行中の PR」の節には触らない)。entries が空なら、印の組を消す (印が無ければ、そのまま)。
 * 印が壊れている (片方だけ、2 組以上、順が逆) 本文は、書き換えない (broken)。
 */
export function updateBody(body: string, entries: readonly PrEntry[]): BodyUpdate {
  const located = locateBlock(body)
  if (located.kind === 'broken') return { kind: 'broken' }
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  if (located.kind === 'none') {
    if (entries.length === 0) return { kind: 'unchanged' }
    const lead = body === '' ? '' : `${body}${body.endsWith('\n') ? '' : eol}${eol}`
    return { kind: 'updated', body: `${lead}${renderBlock(entries, eol)}${eol}` }
  }
  const { start, end } = located.block
  if (entries.length === 0) {
    const before = body.slice(0, start).replace(/(\r?\n){2}$/, eol)
    const after = body.slice(end).replace(before === '' ? /^(\r?\n)+/ : /^\r?\n/, '')
    const next = `${before}${after}`
    return next === body ? { kind: 'unchanged' } : { kind: 'updated', body: next }
  }
  const next = `${body.slice(0, start)}${renderBlock(entries, eol)}${body.slice(end)}`
  return next === body ? { kind: 'unchanged' } : { kind: 'updated', body: next }
}
