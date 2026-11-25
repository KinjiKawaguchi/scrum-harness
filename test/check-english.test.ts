import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/check-english.sh', import.meta.url))
// Written as escapes so that this file stays free of Japanese text.
const HIRAGANA = '\u3053\u3093\u306b\u3061\u306f'
const KATAKANA = '\u30c6\u30b9\u30c8'
const HAN = '\u65e5\u672c\u8a9e'

let repo: string

function git(...args: string[]): void {
  const run = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
}

function track(path: string, text: string): void {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), text)
  git('add', path)
}

const check = () => spawnSync('bash', [SCRIPT, repo], { encoding: 'utf8' })

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'scrum-english-'))
  git('init', '-q')
})

describe('the English check', () => {
  it('passes when every tracked file is English, including accents, symbols, and escapes', () => {
    track('a.ts', "const text = 'café € \\u3053 → ok'\n")
    assert.equal(check().status, 0)
  })

  for (const [name, text] of [['hiragana', HIRAGANA], ['katakana', KATAKANA], ['Han characters', HAN]] as const) {
    it(`fails on ${name} and names the file and line`, () => {
      track('docs/page.md', `line one\nsays ${text}\n`)
      const run = check()
      assert.equal(run.status, 1)
      assert.match(run.stdout, /docs\/page\.md:2:/)
    })
  }

  it('does not look at files that are not tracked', () => {
    track('a.ts', 'ok\n')
    writeFileSync(join(repo, 'scratch.txt'), HIRAGANA)
    assert.equal(check().status, 0)
  })

  it('lets a file on the allow list hold Japanese text, and only that file', () => {
    track('scripts/english-allowlist.txt', '# comment\n\ntest/input.test.ts\n')
    track('test/input.test.ts', HIRAGANA)
    assert.equal(check().status, 0)
    track('src/other.ts', KATAKANA)
    const run = check()
    assert.deepEqual([run.status, run.stdout.includes('src/other.ts'), run.stdout.includes('input.test.ts')], [1, true, false])
  })
})
