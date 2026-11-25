import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gh } from '../src/adapters/github/gh.ts'
import { fetchPrBody } from '../src/adapters/github/pull-requests.ts'

function withFakeGh(script: string, run: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-fake-gh-'))
  writeFileSync(join(dir, 'gh'), script)
  chmodSync(join(dir, 'gh'), 0o755)
  const saved = process.env.PATH
  process.env.PATH = `${dir}:${saved ?? ''}`
  try {
    run()
  } finally {
    process.env.PATH = saved
  }
}

describe('fetchPrBody', () => {
  it("reads the PR body by the number in the repository that was pointed at (-R); does not remap to defaultRepo or the config's repos", () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'scrum-gh-log-')), 'args.txt')
    withFakeGh(`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${logFile}'\necho 'first line of the body'\n`, () => {
      assert.equal(fetchPrBody(gh, 'tool#3', 'other-owner/tool'), 'first line of the body\n')
    })
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), ['pr', 'view', '3', '-R', 'other-owner/tool', '--json', 'body', '--jq', '.body'])
  })

  it('null when gh fails (the merge guidance is simply not shown)', () => {
    withFakeGh('#!/bin/sh\nexit 1\n', () => {
      assert.equal(fetchPrBody(gh, 'tool#3', 'other-owner/tool'), null)
    })
  })
})
