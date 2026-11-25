import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UsageIndex } from '../src/usage/index-store.ts'
import type { Paths } from '../src/store.ts'

export function writeIndexForTest(p: Paths, index: UsageIndex): void {
  mkdirSync(dirname(p.usageIndex), { recursive: true })
  writeFileSync(p.usageIndex, JSON.stringify(index))
}
