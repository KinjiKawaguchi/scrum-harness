/**
 * Text that a person or another system wrote and that the harness passes on. It is shown as data, never as the harness's own wording:
 * a single escaped line cannot start a new finding or command line, and a fenced block keeps Markdown from taking effect.
 */

/** The text as one escaped string literal, cut at `max` characters. */
export function quoteLine(text: string, max: number): string {
  const cut = text.length > max ? `${text.slice(0, max)}...` : text
  return JSON.stringify(cut)
}

/** The text in a Markdown fenced block whose fence is longer than any run of backticks inside, so nothing inside can close it. */
export function fencedBlock(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return [`${fence}text`, text, fence].join('\n')
}
