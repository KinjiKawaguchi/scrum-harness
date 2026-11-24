/**
 * Splits a Bash command string into word lists, one per separator (&&, ||, ;, |, newline).
 * It is a simple parse that merely strips quotes, used only to find commands that touch the board.
 */
export function splitCommands(command: string): readonly (readonly string[])[] {
  const segments: string[][] = [[]]
  let word: string | null = null
  let quote: '"' | "'" | null = null
  const pushWord = () => {
    if (word !== null) segments.at(-1)?.push(word)
    word = null
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    if (quote !== null) {
      if (char === quote) quote = null
      else word = (word ?? '') + char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      word = word ?? ''
    } else if (char === ';' || char === '|' || char === '&' || char === '\n') {
      pushWord()
      if (segments.at(-1)?.length !== 0) segments.push([])
    } else if (char === ' ' || char === '\t') {
      pushWord()
    } else {
      word = (word ?? '') + char
    }
  }
  pushWord()
  return segments.filter((segment) => segment.length > 0)
}

const SHELLS = new Set(['bash', 'sh', 'zsh'])

/** Strips leading environment-variable assignments and a bash-style launcher, leaving the program to run and its arguments. */
export function programAndArgs(words: readonly string[]): { readonly program: string; readonly args: readonly string[] } {
  const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  const rest = start === -1 ? [] : words.slice(start)
  const [first = '', ...args] = rest
  const program = first.split('/').pop() ?? first
  if (SHELLS.has(program) && args.length > 0) return programAndArgs(args)
  return { program, args }
}
