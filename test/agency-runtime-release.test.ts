import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { harnessRelease, isReadableRelease, MOST_RELEASE_CHARS } from '../src/agency-runtime/release.ts'

const packageWith = (content: string): URL => {
  const file = join(mkdtempSync(join(tmpdir(), 'scrum-release-')), 'package.json')
  writeFileSync(file, content)
  return pathToFileURL(file)
}

describe('the release a node can read', () => {
  it('is a short text with no control character', () => {
    assert.equal(isReadableRelease('0.7.2'), true)
    assert.equal(isReadableRelease('x'.repeat(MOST_RELEASE_CHARS)), true)
    assert.deepEqual(['', 'x'.repeat(MOST_RELEASE_CHARS + 1), '0.7\n2', '0.7\u00002', '0.7\u007f2', 7, null, undefined].map(isReadableRelease), Array(8).fill(false))
  })
})

describe('the harness release', () => {
  it('is the version of the package', () => {
    assert.equal(harnessRelease(packageWith('{"name":"x","version":"1.2.3"}')), '1.2.3')
  })

  it('is none when the package has no version a node can read, or cannot be read', () => {
    assert.equal(harnessRelease(packageWith('{"name":"x"}')), null)
    assert.equal(harnessRelease(packageWith(`{"version":"${'9'.repeat(65)}"}`)), null)
    assert.equal(harnessRelease(packageWith('not json')), null)
    assert.equal(harnessRelease(pathToFileURL(join(tmpdir(), 'scrum-release-missing', 'package.json'))), null)
  })

  it('is read from the harness package by default', () => {
    assert.match(harnessRelease() ?? '', /^\d+\.\d+\.\d+/)
  })
})
