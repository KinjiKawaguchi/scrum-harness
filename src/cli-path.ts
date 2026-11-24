import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 注入する文で使うコマンドのパス。TechLead の PATH には入っていないので、パスで書く。 */
export const SCRUM_CLI = fileURLToPath(new URL('../bin/scrum', import.meta.url)).replace(homedir(), '~')

export const RULES_DOC = fileURLToPath(new URL('../docs/rules.md', import.meta.url)).replace(homedir(), '~')
