import { readFileSync } from 'node:fs'

/** The most characters of a release a node reads; a longer value is read as none. */
export const MOST_RELEASE_CHARS = 64

/** A release a node can read: not empty, at most `MOST_RELEASE_CHARS` characters, and no control character. */
export function isReadableRelease(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && [...value].length <= MOST_RELEASE_CHARS && !/\p{Cc}/u.test(value)
}

/** The harness's own release, the `version` of its package.json; null when that cannot be read or a node could not read it. */
export function harnessRelease(packageJson: URL = new URL('../../package.json', import.meta.url)): string | null {
  try {
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown }
    return isReadableRelease(version) ? version : null
  } catch {
    return null
  }
}
