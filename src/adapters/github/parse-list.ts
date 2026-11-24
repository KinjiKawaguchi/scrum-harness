/** gh の `--json` の一覧を読む。配列でなければ投げる。pick が null を返したものは捨てる。 */
export function parseList<T>(output: string, pick: (record: Record<string, any>) => T | null): readonly T[] {
  const list: unknown = JSON.parse(output)
  if (!Array.isArray(list)) throw new Error('the gh output is not an array')
  return list.flatMap((record) => {
    const one = pick(record as Record<string, any>)
    return one === null ? [] : [one]
  })
}
