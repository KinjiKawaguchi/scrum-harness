import { fileURLToPath } from 'node:url'
import type { ProductLauncher } from '../../ports/launcher.ts'

/** The hooks a Codex member runs, with the time each may take (seconds). The same events and limits as the hooks of a Claude Code member. */
const HOOKS: readonly (readonly [string, number])[] = [
  ['SessionStart', 30],
  ['UserPromptSubmit', 15],
  ['PreToolUse', 10],
  ['PostToolUse', 30],
  ['Stop', 15],
  ['SessionEnd', 10],
]

const SCRUM = fileURLToPath(new URL('../../../bin/scrum', import.meta.url))

/** A word for a shell line: left alone when it is plain, otherwise in single quotes. */
const shellWord = (word: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)

/** A TOML basic string. JSON's string syntax is valid TOML for what is written here (the escapes are the same). */
const tomlString = (value: string): string => JSON.stringify(value)

/**
 * `-c hooks.<Event>=[{hooks=[{type="command",command="<scrum> hook <Event>",timeoutSec=<n>}]}]`: a hook given at the start of the session, so nothing is
 * written under `~/.codex`. With no matcher it sees every tool call. Codex gives its hooks the same event names and input as Claude Code, and the
 * environment of the member (`SCRUM_STATE_DIR`, `SCRUM_NAME`) reaches them.
 */
function hookArguments(scrum: string): readonly string[] {
  return HOOKS.flatMap(([event, timeoutSec]) => ['-c', `hooks.${event}=[{hooks=[{type="command",command=${tomlString(`${shellWord(scrum)} hook ${event}`)},timeoutSec=${timeoutSec}}]}]`])
}

/**
 * `codex [options] "<brief>"` with the harness's hooks passed by `-c`. Nobody can answer a hook trust prompt in a member's window, so the hooks are trusted
 * for the session (`--dangerously-bypass-hook-trust`); this also trusts any hook a project of the member defines. Approvals and the sandbox follow the
 * user's Codex configuration unless the member says `sandbox`, and `permissions: "skip"` is the only way `--dangerously-bypass-approvals-and-sandbox` is passed.
 * A Codex session has no name flag: the member is known by `SCRUM_NAME`.
 */
export const codexLauncher: ProductLauncher = ({ spec, brief }, scrum = SCRUM) => [
  'codex',
  ...(spec.permissions === 'skip' ? ['--dangerously-bypass-approvals-and-sandbox'] : spec.sandbox === undefined ? [] : ['-s', spec.sandbox]),
  '--dangerously-bypass-hook-trust',
  ...(spec.model === undefined ? [] : ['-m', spec.model]),
  ...(spec.effort === undefined ? [] : ['-c', `model_reasoning_effort=${tomlString(spec.effort)}`]),
  ...hookArguments(scrum),
  ...(brief === '' ? [] : [brief]),
]
