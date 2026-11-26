import type { TranscriptFile, TranscriptSource } from '../ports/index.ts'

/**
 * One transcript source over several agent products. A file is scanned by the source that listed it. The names of every source are offered, the
 * first source's winning when two give a session a name.
 */
export function composeTranscripts(sources: readonly TranscriptSource[]): TranscriptSource {
  const owner = new Map<string, TranscriptSource>()
  return {
    files: () =>
      sources.flatMap((source) =>
        source.files().map((file): TranscriptFile => {
          owner.set(file.path, source)
          return file
        }),
      ),
    names: () => new Map(sources.toReversed().flatMap((source) => [...source.names()])),
    scan: (file, from, skip) => {
      const source = owner.get(file.path)
      if (source === undefined) throw new Error(`no transcript source lists ${file.path}`)
      return source.scan(file, from, skip)
    },
  }
}
