import { realpathSync } from 'node:fs'

/** What Codex asks the first time it runs in a directory. */
export const CODEX_TRUST_QUESTION = /Do you trust the contents of this directory\?/

/** What Claude Code asks the first time a login runs in a folder (its "Accessing workspace" screen). */
const CLAUDE_TRUST_QUESTION = /Quick safety check: Is this a project you created or one you trust\?/

/**
 * The same screen has a longer form when the folder brings settings that run code (hooks, MCP servers, commands that run without asking). Trusting that
 * is a bigger step than trusting a folder, so the harness leaves it to a person.
 */
const CLAUDE_TRUST_WITH_CODE = /configures hooks|MCP server|without asking/i

const flat = (text: string): string => text.replace(/\s+/g, ' ')
const squeeze = (text: string): string => text.replace(/\s+/g, '')

/** Whether a window is at Claude Code's question about trusting the folder it runs in. */
export const asksClaudeTrust = (screen: string | null): boolean => CLAUDE_TRUST_QUESTION.test(flat(screen ?? ''))

/** The folder the screen says Claude Code is "Accessing", with the line breaks of a long path taken out. Null when the screen does not show one. */
function shownFolder(screen: string): string | null {
  const shown = /Accessing workspace:(.*?)Quick safety check/.exec(flat(screen))?.[1]
  return shown === undefined || squeeze(shown) === '' ? null : squeeze(shown)
}

/** The folder as a path and, when it exists, as the system names it (the screen shows the resolved name, `/private/tmp` for `/tmp`). */
function namesOf(dir: string): readonly string[] {
  try {
    return [squeeze(dir), squeeze(realpathSync(dir))]
  } catch {
    return [squeeze(dir)]
  }
}

/**
 * The key that moves Claude Code's trust question towards "Yes, I trust this folder", or null when the harness should leave the screen alone. The question
 * opens with "No, exit" focused, so the answer is two keys: Down to the Yes line, then Enter. Which line is focused is read from the screen each time,
 * so a key that was not taken (the question ignores input for a moment after it opens) is simply sent again at the next look.
 * Only the plain question, and only for the folder the member is configured to run in: another folder, or the longer form that carries settings that
 * run code, is left for a person.
 */
export function claudeTrustKey(screen: string | null, dir: string): 'Down' | 'Enter' | null {
  const text = screen ?? ''
  if (!asksClaudeTrust(text) || CLAUDE_TRUST_WITH_CODE.test(flat(text))) return null
  const folder = shownFolder(text)
  if (folder === null || !namesOf(dir).includes(folder)) return null
  const focused = /^[ \t]*[\u276F\u203A>][ \t]*(No, exit|Yes, I trust this folder)/m.exec(text)?.[1]
  if (focused === undefined) return null
  return focused === 'No, exit' ? 'Down' : 'Enter'
}

/** The question of a product a window waits at: its name (for a line of a list), and what lets the harness answer it (for a message). Null when it shows none of the ones known. */
export function questionOf(screen: string | null): { readonly name: string; readonly hint: string } | null {
  if (asksClaudeTrust(screen)) return { name: "Claude Code's question whether to trust the folder", hint: "`trustDirectory: true` has the harness answer it for the member's own folder" }
  if (CODEX_TRUST_QUESTION.test(screen ?? '')) return { name: "Codex's question whether to trust the directory", hint: "`trustDirectory: true` has the harness answer it for the member's own directory" }
  return null
}

/** What a window that is waiting at a question of the product is waiting for, in words for a message. Null when it shows none of the ones known. */
export function screenQuestion(screen: string | null): string | null {
  const question = questionOf(screen)
  return question === null ? null : `it is waiting at ${question.name} (${question.hint})`
}
