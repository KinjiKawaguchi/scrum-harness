import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeJson, type Paths } from './store.ts'

/** A mark that identifies the hooks that were added. It is included in the command's path. */
export const MARKER = 'scrum-harness'

type HookEntry = { readonly type: string; readonly command?: string; readonly timeout?: number; readonly asyncRewake?: boolean }
type HookGroup = { readonly matcher?: string; readonly hooks: readonly HookEntry[] }
type Settings = { readonly hooks?: Readonly<Record<string, readonly HookGroup[]>> } & Record<string, unknown>

/** timeout applies to asyncRewake hooks, so it is set slightly longer than the watch's upper limit (50 minutes). */
const WATCH_TIMEOUT_SECONDS = 3100

function groups(bin: string): Readonly<Record<string, readonly HookGroup[]>> {
  const hook = (event: string, timeout: number): HookEntry => ({ type: 'command', command: `${bin} hook ${event}`, timeout })
  const watch: HookEntry = { type: 'command', command: `${bin} watch`, asyncRewake: true, timeout: WATCH_TIMEOUT_SECONDS }
  return {
    SessionStart: [{ hooks: [hook('SessionStart', 30), watch] }],
    UserPromptSubmit: [{ hooks: [hook('UserPromptSubmit', 15)] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [hook('PreToolUse', 10)] }],
    PostToolUse: [{ hooks: [hook('PostToolUse', 30)] }],
    Stop: [{ hooks: [hook('Stop', 15), watch] }],
    Notification: [{ matcher: 'permission_prompt', hooks: [hook('Notification', 10)] }],
    SessionEnd: [{ hooks: [hook('SessionEnd', 10)] }],
  }
}

const isOurs = (group: HookGroup): boolean => group.hooks.some((hook) => hook.command?.includes(MARKER) === true)

export function withoutHooks(settings: Settings): Settings {
  const entries = Object.entries(settings.hooks ?? {})
    .map(([event, list]) => [event, list.filter((group) => !isOurs(group))] as const)
    .filter(([, list]) => list.length > 0)
  const { hooks: _hooks, ...rest } = settings
  return entries.length === 0 ? rest : { ...rest, hooks: Object.fromEntries(entries) }
}

export function withHooks(settings: Settings, bin: string): Settings {
  const base = withoutHooks(settings).hooks ?? {}
  const ours = groups(bin)
  const events = [...new Set([...Object.keys(base), ...Object.keys(ours)])]
  const hooks = Object.fromEntries(events.map((event) => [event, [...(base[event] ?? []), ...(ours[event] ?? [])]]))
  return { ...settings, hooks }
}

/**
 * Takes a copy of settings.json and then rewrites the hooks. A configuration directory that has no settings.json yet gets one (there is nothing to copy);
 * the returned backup is null then.
 */
export function updateSettings(settingsPath: string, change: (settings: Settings) => Settings): string | null {
  const isNew = !existsSync(settingsPath)
  const backup = `${settingsPath}.bak-scrum-harness`
  if (!isNew) copyFileSync(settingsPath, backup)
  const current = isNew ? {} : (JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings)
  if (isNew) mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(change(current), null, 2)}\n`)
  return isNew ? null : backup
}

/** If there is no config, copies the example. The example's values must be adjusted to match the board. */
export function ensureConfig(p: Paths): boolean {
  const path = `${p.dir}/config.json`
  if (existsSync(path)) return false
  writeJson(path, JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')))
  return true
}
