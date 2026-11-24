export type PrEntry = { readonly number: number; readonly title: string }

/** The markers enclosing the range the machine writes. Only between them is rewritten. Headings and sections a person wrote are not touched. */
export const MARKER_START = '<!-- scrum-harness:prs -->'
export const MARKER_END = '<!-- /scrum-harness:prs -->'

const LABEL = 'PRs in progress (automatic)'
const TITLE_LIMIT = 60

/** Removes the `(#N)` (and `(#N, #M)`) in a title along with its parentheses, and the remaining `#N` and `@`. So as not to add mentions of issues or mention notifications. */
function cleanTitle(title: string): string {
  return title
    .replace(/\s*\(\s*#\d+(?:\s*[,\u3001]\s*#\d+)*\s*\)/g, '')
    .replace(/#(\d+)/g, '$1')
    .replace(/@/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Limits a title to TITLE_LIMIT characters. A parenthesis opened at the cut point is closed (so the parenthesis pairs are not broken). */
export function describe(title: string): string {
  const clean = cleanTitle(title)
  if (clean.length <= TITLE_LIMIT) return clean
  const cut = clean.slice(0, TITLE_LIMIT)
  const open = [...cut].filter((char) => char === '(').length - [...cut].filter((char) => char === ')').length
  return `${cut}…${')'.repeat(Math.max(0, open))}`
}

/** One line of `#<number> (description)` entries lined up with ` / `. */
export function entryLine(entries: readonly PrEntry[]): string {
  return entries.map((entry) => `#${entry.number} (${describe(entry.title)})`).join(' / ')
}

/** The location in the body of the range the machine writes (between the markers, and the markers). */
type Block = { readonly start: number; readonly end: number }

/** The position of the start of a line outside code fences (```), and that line's string. */
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
 * Finds the pair of markers. Markers inside code fences are not counted. It is found when there is exactly one of each, in the order start then end.
 * If only one exists, there are two or more, or the order is reversed, it is broken (not rewritten). If neither exists, it is absent.
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
 * Rewrites only between the markers of an issue body, as entries says. Not one character outside the markers is changed.
 * If there are no markers, it only appends to the end of the body (the person's existing "## PRs in progress" section is not touched). If entries is empty, the pair of markers is removed (if there are no markers, the body is left as is).
 * A body whose markers are broken (only one, two or more pairs, reversed order) is not rewritten (broken).
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
