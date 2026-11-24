import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('gh and ghWithin', () => {
  const module = pathToFileURL(new URL('../src/adapters/github/gh.ts', import.meta.url).pathname).href
  const calls = [
    ['gh', "gh(['x'])"],
    ['ghWithin', "ghWithin(5000)(['x'])"],
  ] as const

  for (const [name, call] of calls) {
    it(`${name}: does not pass the standard error of a gh failure on to the parent's standard error (it would mix into the message a watch process starts); the thrown exception carries it`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'scrum-fake-gh-'))
      writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "gh error sentence" >&2\nexit 1\n')
      chmodSync(join(dir, 'gh'), 0o755)
      const code = `import { gh, ghWithin } from ${JSON.stringify(module)}\ntry { ${call} } catch (error) { process.stdout.write('threw:' + String(error.stderr)) }`
      const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin` } })
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stderr, /gh error sentence/)
      assert.match(result.stdout, /^threw:gh error sentence/)
    })
  }
})
