import { readFileSync } from 'node:fs'

/** Agency's shared TeamView sample, copied by scripts/agency-contract.sh. */
export const SAMPLE_PATH = new URL('./fixtures/agency/teamview.sample.json', import.meta.url)
export const sample = (): unknown => JSON.parse(readFileSync(SAMPLE_PATH, 'utf8'))

/** Every key that appears anywhere in a JSON value. */
export function keysOf(value: unknown): ReadonlySet<string> {
  if (Array.isArray(value)) return new Set(value.flatMap((one) => [...keysOf(one)]))
  if (typeof value !== 'object' || value === null) return new Set()
  return new Set(Object.entries(value).flatMap(([key, one]) => [key, ...keysOf(one)]))
}
