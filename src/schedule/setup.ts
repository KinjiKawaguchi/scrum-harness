import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ScheduleSetup } from '../ports/index.ts'

const SYSTEM_DIRS = ['/usr/bin', '/bin']

export type SetupInputs = {
  readonly home: string
  readonly scrumDir: string
  readonly stateDir: string
  readonly defaultStateDir: string
  /** The program that is running (node), and the folders of the login shell's PATH where `gh` can be looked up */
  readonly nodePath: string
  readonly shellPath: string
  readonly instance: string
  /** True for `install` and `print`, which put gh into the job's PATH. `status` and `uninstall` do not need gh. */
  readonly requireGh: boolean
  readonly isExecutable?: (path: string) => boolean
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const INSTANCE = /^[a-z0-9][a-z0-9-]{0,29}$/

/**
 * Works out the PATH a scheduled job runs with: the folder of node, the folder of `gh`, and the system folders. The schedulers do not
 * pass on the login shell's PATH, so the job finds node and gh only through this. It stops when either is missing from that PATH alone.
 */
export function scheduleSetup(inputs: SetupInputs): ScheduleSetup | string {
  const isExecutable = inputs.isExecutable ?? executable
  if (!INSTANCE.test(inputs.instance) && inputs.instance !== '') return `--name must be lowercase letters, digits, and dashes (got "${inputs.instance}")`
  const nodeDir = dirname(inputs.nodePath)
  const ghDir = inputs.shellPath.split(':').find((dir) => dir !== '' && isExecutable(join(dir, 'gh')))
  if (ghDir === undefined && inputs.requireGh) return 'gh was not found in PATH; install the GitHub CLI first'
  const path = [...new Set([nodeDir, ...(ghDir === undefined ? [] : [ghDir]), ...SYSTEM_DIRS])].join(':')
  if (!isExecutable(inputs.nodePath)) return `node is not executable: ${inputs.nodePath}`
  return {
    home: inputs.home,
    scrumDir: inputs.scrumDir,
    path,
    stateDir: inputs.stateDir,
    isCustomStateDir: inputs.stateDir !== inputs.defaultStateDir,
    instance: inputs.instance,
  }
}
