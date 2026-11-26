import { readJson, writeJson } from '../store.ts'
import type { Ports } from '../ports/index.ts'

/** The login directories of the node's funding sources, kept so that reading sessions and transcripts needs no call to the node. */
export type FundingDirs = {
  readonly at: string
  /** `CLAUDE_CONFIG_DIR` of each Claude source that has one */
  readonly claude: readonly string[]
  /** `CODEX_HOME` of each Codex source that has one */
  readonly codex: readonly string[]
}

const EMPTY: FundingDirs = { at: '', claude: [], codex: [] }

export function readFundingDirs(path: string): FundingDirs {
  const stored = readJson<Partial<FundingDirs>>(path, EMPTY)
  const isTexts = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')
  return { at: typeof stored.at === 'string' ? stored.at : '', claude: isTexts(stored.claude) ? stored.claude : [], codex: isTexts(stored.codex) ? stored.codex : [] }
}

/**
 * Asks the node for its funding sources and keeps their login directories. Returns why it could not, and then keeps what it had: a node that is down must
 * not make the harness forget where its members' sessions are. Null when there is no funding command, or it worked.
 */
export function refreshFundingDirs(ports: Ports, path: string, now: Date): string | null {
  if (ports.fundingSources === null) return null
  try {
    const sources = ports.fundingSources()
    const dirsOf = (tool: 'claude' | 'codex', key: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'): readonly string[] => [...new Set(sources.filter((source) => source.tool === tool).flatMap((source) => source.env[key] ?? []))]
    writeJson(path, { at: now.toISOString(), claude: dirsOf('claude', 'CLAUDE_CONFIG_DIR'), codex: dirsOf('codex', 'CODEX_HOME') } satisfies FundingDirs)
    return null
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 300)
  }
}
