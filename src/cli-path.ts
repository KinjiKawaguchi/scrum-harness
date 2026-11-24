import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** The command path used in injected text. It is not in the TechLead's PATH, so it is written as a path. */
export const SCRUM_CLI = fileURLToPath(new URL('../bin/scrum', import.meta.url)).replace(homedir(), '~')

export const RULES_DOC = fileURLToPath(new URL('../docs/rules.md', import.meta.url)).replace(homedir(), '~')
