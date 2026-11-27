import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_INDEX, readIndex, type UsageIndex } from '../src/usage/index-store.ts'

describe('reading the usage index again and again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-index-read-'))
  const path = join(dir, 'usage-index.json')
  const index = (models: readonly string[]): UsageIndex => ({ ...EMPTY_INDEX, updatedAt: '2026-10-08T06:00:00.000Z', models })

  it('parses a file once while its size and time are the same, and again when it changed', () => {
    writeFileSync(path, JSON.stringify(index(['a'])))
    const first = readIndex(path)
    assert.deepEqual(first?.models, ['a'])
    assert.equal(readIndex(path), first)
    writeFileSync(path, JSON.stringify(index(['a', 'b'])))
    assert.deepEqual(readIndex(path)?.models, ['a', 'b'])
    const same = JSON.stringify(index(['a', 'c']))
    writeFileSync(path, same)
    utimesSync(path, new Date(), new Date(Date.now() + 10_000))
    assert.deepEqual(readIndex(path)?.models, ['a', 'c'])
  })

  it('is null for a file that is gone or is not an index, and reads it when it comes back', () => {
    writeFileSync(path, '{"version":2}')
    assert.equal(readIndex(path), null)
    rmSync(path)
    assert.equal(readIndex(path), null)
    writeFileSync(path, JSON.stringify(index(['z'])))
    assert.deepEqual(readIndex(path)?.models, ['z'])
  })
})
