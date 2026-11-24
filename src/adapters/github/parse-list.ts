/** Reads a list from gh's `--json`. Throws if it is not an array. Items for which pick returns null are discarded. */
export function parseList<T>(output: string, pick: (record: Record<string, any>) => T | null): readonly T[] {
  const list: unknown = JSON.parse(output)
  if (!Array.isArray(list)) throw new Error('the gh output is not an array')
  return list.flatMap((record) => {
    const one = pick(record as Record<string, any>)
    return one === null ? [] : [one]
  })
}
