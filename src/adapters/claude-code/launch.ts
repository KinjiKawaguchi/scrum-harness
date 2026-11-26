import type { ProductLauncher } from '../../ports/launcher.ts'

/**
 * `claude -n <name> [--resume <session>] --model <model> --effort <level> "<brief>"`. Permission prompts are on unless the member says `permissions: "skip"`,
 * which is the only way `--dangerously-skip-permissions` is passed.
 */
export const claudeCodeLauncher: ProductLauncher = ({ name, spec, brief, resume }) => [
  'claude',
  ...(spec.permissions === 'skip' ? ['--dangerously-skip-permissions'] : []),
  '-n',
  name,
  ...(resume === undefined ? [] : ['--resume', resume]),
  ...(spec.model === undefined ? [] : ['--model', spec.model]),
  ...(spec.effort === undefined ? [] : ['--effort', spec.effort]),
  ...(brief === '' ? [] : [brief]),
]
