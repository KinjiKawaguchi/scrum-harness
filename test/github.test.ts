import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('gh と ghWithin', () => {
  const module = pathToFileURL(new URL('../src/github.ts', import.meta.url).pathname).href
  const calls = [
    ['gh', "gh(['x'])"],
    ['ghWithin', "ghWithin(5000)(['x'])"],
  ] as const

  for (const [name, call] of calls) {
    it(`${name}: gh の失敗の標準エラーを、親の標準エラーに流さない (待機プロセスが起こす文に混ざるため)。投げる例外には持たせる`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'scrum-fake-gh-'))
      writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "gh のエラーの文" >&2\nexit 1\n')
      chmodSync(join(dir, 'gh'), 0o755)
      const code = `import { gh, ghWithin } from ${JSON.stringify(module)}\ntry { ${call} } catch (error) { process.stdout.write('threw:' + String(error.stderr)) }`
      const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin` } })
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stderr, /gh のエラーの文/)
      assert.match(result.stdout, /^threw:gh のエラーの文/)
    })
  }
})
