#!/usr/bin/env node
// A fake tracker for the tests of the `scrum-board/1` adapter. It answers from what the request's `options` say, so a test controls every answer:
//   options.snapshot      the answer to `snapshot`
//   options.statusEvents  the answer to `statusEvents` (null when absent)
//   options.comments      the answer to `comments`
//   options.failOps       the ops (a list of names) that answer an error
//   options.mode          "error" answers an error, "garbage" prints text that is not JSON, "silent" answers nothing, "slow" waits too long
// Every request is also appended, as one line, to the file named in options.log, so a test can see what the harness asked.
import { appendFileSync } from 'node:fs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  const { options = {} } = request
  if (options.log) appendFileSync(options.log, `${JSON.stringify(request)}\n`)
  if (request.board !== 'scrum-board/1') return fail('unknown board protocol')
  if (options.mode === 'garbage') return void process.stdout.write('this is not json')
  if (options.mode === 'silent') return
  if (options.mode === 'slow') return void setTimeout(() => undefined, 60_000)
  if (options.mode === 'error') return fail('the tracker is down')
  if ((options.failOps ?? []).includes(request.op)) return fail(`${request.op} failed`)
  if (request.op === 'snapshot') return answer(options.snapshot)
  if (request.op === 'statusEvents') return answer(options.statusEvents ?? null)
  if (request.op === 'comments') return answer(options.comments ?? [])
  if (['set', 'add', 'comment'].includes(request.op)) return answer({})
  return fail(`unsupported op ${request.op}`)
})

function answer(result) {
  process.stdout.write(JSON.stringify({ result }))
}

function fail(message) {
  process.stdout.write(JSON.stringify({ error: { message } }))
  process.exitCode = 1
}
