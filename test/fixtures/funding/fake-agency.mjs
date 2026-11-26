#!/usr/bin/env node
// A stand-in for `agency funding`: prints FAKE_PICK and exits with FAKE_EXIT; appends its arguments to FAKE_ARGS.
import { appendFileSync } from 'node:fs'
if (process.env.FAKE_ARGS) appendFileSync(process.env.FAKE_ARGS, `${JSON.stringify(process.argv.slice(2))}\n`)
if (process.env.FAKE_HANG) await new Promise((resolve) => setTimeout(resolve, 60_000))
process.stdout.write(process.env.FAKE_PICK ?? '')
process.stderr.write(process.env.FAKE_STDERR ?? '')
process.exit(Number(process.env.FAKE_EXIT ?? 0))
