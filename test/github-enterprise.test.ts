import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseBoardCommands } from '../src/adapters/github/action-reader.ts'
import { realExec } from '../src/adapters/github/board-writer.ts'
import { ghEnv } from '../src/adapters/github/gh.ts'
import { lintBoard } from '../src/board/rules.ts'
import { isHostName, parseConfig } from '../src/config.ts'
import { paths } from '../src/store.ts'
import { config as base, NOW, pr, snapshot } from './helpers.ts'

const HOST = 'ghe.example.com'

describe('the GitHub host', () => {
  it('points gh at the configured host with GH_HOST, and leaves gh\'s own default alone without one', () => {
    assert.deepEqual(ghEnv(HOST, { PATH: '/bin' }), { PATH: '/bin', GH_HOST: HOST })
    assert.deepEqual(ghEnv(undefined, { PATH: '/bin' }), { PATH: '/bin' })
    assert.equal(ghEnv(HOST, { GH_HOST: 'github.com' }).GH_HOST, HOST)
  })

  it('accepts a host name with an optional port and refuses anything else, so a call never goes to another host', () => {
    for (const ok of ['ghe.example.com', 'github.com', 'ghe.corp.example.com:8443', 'localhost']) assert.equal(isHostName(ok), true, ok)
    for (const bad of ['', 'https://ghe.example.com', 'ghe.example.com/path', '-x.example.com', 'ghe example.com', 7, null]) assert.equal(isHostName(bad), false, String(bad))
  })

  it('reads `host` from the configuration, and makes a configuration with a malformed one unusable', () => {
    assert.equal(parseConfig({ ...base, host: HOST })?.host, HOST)
    assert.equal(parseConfig(base)?.host, undefined)
    assert.equal(parseConfig({ ...base, host: 'https://ghe.example.com' }), null)
  })

  it('runs gh with GH_HOST set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-fake-gh-'))
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "%s" "$GH_HOST"\n')
    chmodSync(join(dir, 'gh'), 0o755)
    const module = pathToFileURL(new URL('../src/adapters/github/gh.ts', import.meta.url).pathname).href
    const code = `import { ghFor } from ${JSON.stringify(module)}\nprocess.stdout.write([ghFor(${JSON.stringify(HOST)}).run(['x']), ghFor(${JSON.stringify(HOST)}).within(5000)(['x']), '|', ghFor(undefined).run(['x'])].join(','))`
    const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin` } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${HOST},${HOST},|,`)
  })

  it('runs the board scripts with GH_HOST set too, since they call gh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-fake-script-'))
    const out = join(dir, 'host.txt')
    writeFileSync(join(dir, 'set-status'), `#!/bin/sh\nprintf "%s" "$GH_HOST" > ${out}\n`)
    chmodSync(join(dir, 'set-status'), 0o755)
    realExec({ ...base, host: HOST, dispatch: { enabled: false, baseBranch: 'main', skipLabels: [], utcOffset: '+09:00', notes: [], scriptDir: dir } })('set-status', ['1', 'Done'])
    assert.equal(readFileSync(out, 'utf8'), HOST)
  })

  it('reads a board command typed with GH_HOST in front and a repository that names the host', () => {
    const commands = parseBoardCommands(`GH_HOST=${HOST} gh pr merge 12 -R ${HOST}/example-org/app`, base)
    assert.deepEqual(commands, [{ kind: 'merge-pr', label: 'app#12', repo: `${HOST}/example-org/app` }])
  })

  it('names the host in the fix text that runs gh itself', () => {
    const findings = lintBoard(snapshot([pr(102, { status: 'In Progress' })]), { ...base, host: HOST }, NOW)
    assert.match(findings[0]?.fix ?? '', new RegExp(`^GH_HOST=${HOST} gh project item-edit`))
  })
})

describe('a sign-in failure in the error log', () => {
  const failure = (stderr: string) => Object.assign(new Error('Command failed'), { status: 1, stderr })
  const logged = async (stderr: string): Promise<string> => {
    const { logError } = await import('../src/store.ts')
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-log-')))
    logError(p, 'refresh', failure(stderr))
    return readFileSync(p.errors, 'utf8')
  }

  it('says to authorize the token for the organization\'s SSO', async () => {
    assert.match(await logged('HTTP 403: Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.'), /authorize the token for the organization's SSO/)
  })

  it('says to sign gh in to the host', async () => {
    assert.match(await logged('HTTP 401: Bad credentials (https://ghe.example.com/api/graphql)'), /gh auth login --hostname/)
  })

  it('adds nothing to other failures', async () => {
    assert.doesNotMatch(await logged('gh: Something went wrong while executing your query.'), /hint/)
  })
})
