import type { Tokens } from '../ports/index.ts'

/**
 * The one place that prices tokens. Costs are an estimate of what the usage would cost on the API's published prices; a subscription
 * plan is a flat fee, so this is not a bill. Prices are USD per million tokens. Writing to the prompt cache costs 1.25 times the input
 * price for 5 minutes and 2 times for 1 hour; reading differs per model, so it is listed.
 * Checked against the published prices on 2026-11-25. Not modelled: Haiku 5.5 costs 5 times as much for a prompt above 100K tokens.
 */
export type Price = { readonly input: number; readonly output: number; readonly cacheRead: number }

/** The first pattern that matches wins, so a newer model comes before the family it belongs to. */
const PRICES: readonly (readonly [RegExp, Price])[] = [
  [/^claude-fable-5-2/, { input: 8, output: 40, cacheRead: 0.2 }],
  [/^claude-mythos-5-2/, { input: 8, output: 40, cacheRead: 0.2 }],
  [/^claude-(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/^claude-(fable|mythos)-5/, { input: 10, output: 50, cacheRead: 1 }],
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/^claude-opus-(5|4-[5-9])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/^claude-opus-4/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/^claude-sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.1 }],
  [/^claude-sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/^claude-sonnet-4/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/^claude-haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/^claude-haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
]

/** A model not in the table is priced as Opus 5.5, the default model, rather than guessed high. */
const FALLBACK: Price = { input: 4, output: 20, cacheRead: 0.2 }

const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2
/** Fast mode (usage.speed is "fast") costs twice as much per token. */
const FAST_MULTIPLIER = 2

/** The prices of models of other products. None is listed: dollars are given only for a model with a published price, so a model of another product costs 0 here. */
const isClaude = (model: string): boolean => model.startsWith('claude-')

export function priceOf(model: string): Price {
  return PRICES.find(([pattern]) => pattern.test(model))?.[1] ?? FALLBACK
}

/** The estimated cost in USD, not rounded. */
export function costOf(model: string, tokens: Tokens, isFast: boolean): number {
  if (!isClaude(model)) return 0
  const price = priceOf(model)
  const usd =
    (tokens.input * price.input +
      tokens.cacheWrite5m * price.input * CACHE_WRITE_5M +
      tokens.cacheWrite1h * price.input * CACHE_WRITE_1H +
      tokens.cacheRead * price.cacheRead +
      tokens.output * price.output) /
    1_000_000
  return isFast ? usd * FAST_MULTIPLIER : usd
}

export const roundToCents = (usd: number): number => Math.round(usd * 100) / 100
