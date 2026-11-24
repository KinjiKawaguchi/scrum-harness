import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchPrBody } from '../src/runtime.ts'

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
  it('PR の本文を、指したリポジトリ (-R) の番号で読む。defaultRepo や設定の repos に引き直さない', () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'scrum-gh-log-')), 'args.txt')
    withFakeGh(`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${logFile}'\necho '本文の 1 行目'\n`, () => {
      assert.equal(fetchPrBody('tool#3', 'other-owner/tool'), '本文の 1 行目\n')
    })
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), ['pr', 'view', '3', '-R', 'other-owner/tool', '--json', 'body', '--jq', '.body'])
  })

  it('gh が失敗したら null (マージの案内を出さないだけ)', () => {
    withFakeGh('#!/bin/sh\nexit 1\n', () => {
      assert.equal(fetchPrBody('tool#3', 'other-owner/tool'), null)
    })
  })
})
