import { readJson, writeJson } from '../store.ts'

/** A member that did not show a sign of life after its start and its retries. Kept until it does, or is started again and does. */
export type StartFailure = { readonly name: string; readonly at: string; readonly tries: number }

export const readStartFailures = (path: string): readonly StartFailure[] => readJson<readonly StartFailure[]>(path, [])

export function recordStartFailure(path: string, failure: StartFailure): void {
  writeJson(path, [...readStartFailures(path).filter((one) => one.name !== failure.name), failure])
}

export function clearStartFailure(path: string, name: string): void {
  const before = readStartFailures(path)
  if (before.some((one) => one.name === name)) writeJson(path, before.filter((one) => one.name !== name))
}
