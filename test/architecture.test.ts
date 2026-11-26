import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []))
}

describe('the dependency direction', () => {
  it('has no file outside src/adapters and src/wiring.ts that imports an adapter', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file))
      .filter((file) => !file.startsWith('adapters/') && file !== 'wiring.ts' && !file.startsWith('agency-runtime/bindings/'))
      .filter((file) => /from '[^']*\/adapters\//.test(readFileSync(join(SRC, file), 'utf8')))
    assert.deepEqual(offenders, [])
  })
})
