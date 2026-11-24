import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasCodeChanged } from '../src/code-change.ts'

describe('hasCodeChanged', () => {
  function tree(mtimeSeconds: number) {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-src-'))
    mkdirSync(join(dir, 'board'))
    for (const file of ['cli.ts', join('board', 'rules.ts')]) {
      writeFileSync(join(dir, file), '')
      utimesSync(join(dir, file), mtimeSeconds, mtimeSeconds)
    }
    return dir
  }

  it('false when no source changed after startup', () => {
    assert.equal(hasCodeChanged(tree(1000), 2000 * 1000), false)
  })

  it('true when a source in a subdirectory changed after startup (so a watch process does not keep running old code)', () => {
    const dir = tree(1000)
    utimesSync(join(dir, 'board', 'rules.ts'), 3000, 3000)
    assert.equal(hasCodeChanged(dir, 2000 * 1000), true)
  })

  it('false when the directory cannot be read (not a reason to stop)', () => {
    assert.equal(hasCodeChanged(join(tmpdir(), 'no-such-dir-scrum'), 0), false)
  })
})
