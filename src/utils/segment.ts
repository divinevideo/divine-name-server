// ABOUTME: Cheapest word readings of a username, with and without a blocked word.
// ABOUTME: Digits are their own segments so a digit no longer voids the parse.

export interface Reading {
  cost: number
  segments: string[]
}

const MAX_LETTERS = 20
const DIGIT_COST = 6
const FORCED_WORD_COST = 8

export function lexiconFromLines(text: string): Map<string, number> {
  const freq = new Map<string, number>()
  for (const line of text.split('\n')) {
    const [word, count] = line.trim().split(/\s+/)
    if (!word || !/^[a-z]+$/.test(word)) continue
    const n = Number(count)
    if (!Number.isFinite(n) || n <= 0) continue
    freq.set(word, n)
  }
  let total = 0
  for (const n of freq.values()) total += n
  if (total === 0) return new Map()
  const costs = new Map<string, number>()
  for (const [word, n] of freq) costs.set(word, -Math.log(n / total))
  return costs
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

function endsFrom(text: string, start: number): number[] {
  if (start >= text.length) return []
  if (isDigit(text[start])) {
    let end = start + 1
    while (end < text.length && isDigit(text[end])) end++
    return [end]
  }
  const limit = Math.min(text.length, start + MAX_LETTERS)
  const ends: number[] = []
  for (let end = start + 1; end <= limit; end++) ends.push(end)
  return ends
}

function spanCost(
  span: string,
  lexicon: Map<string, number>,
  termMatches: (span: string) => boolean,
  allowTerm: boolean
): number | null {
  if (/^[0-9]+$/.test(span)) return DIGIT_COST + span.length * 0.05
  const known = lexicon.get(span)
  if (termMatches(span)) {
    if (!allowTerm) return null
    return known ?? FORCED_WORD_COST
  }
  return known === undefined ? null : known
}

function cheapest(
  text: string,
  lexicon: Map<string, number>,
  termMatches: (span: string) => boolean,
  allowTerm: boolean,
  requireTerm: boolean
): Reading | null {
  const n = text.length
  const inf = Number.POSITIVE_INFINITY
  const cost = Array.from({ length: n + 1 }, () => [inf, inf])
  const prevAt: Array<Array<number>> = Array.from({ length: n + 1 }, () => [-1, -1])
  const prevUsed: Array<Array<number>> = Array.from({ length: n + 1 }, () => [0, 0])
  cost[0][0] = 0

  for (let i = 0; i < n; i++) {
    for (const used of [0, 1]) {
      if (cost[i][used] === inf) continue
      for (const end of endsFrom(text, i)) {
        const span = text.slice(i, end)
        const added = spanCost(span, lexicon, termMatches, allowTerm)
        if (added === null) continue
        const nextUsed = used || (termMatches(span) ? 1 : 0)
        const next = cost[i][used] + added
        if (next < cost[end][nextUsed]) {
          cost[end][nextUsed] = next
          prevAt[end][nextUsed] = i
          prevUsed[end][nextUsed] = used
        }
      }
    }
  }

  const used = requireTerm ? 1 : 0
  if (cost[n][used] === inf) return null
  const segments: string[] = []
  let at = n
  let flag = used
  while (at > 0) {
    const from = prevAt[at][flag]
    if (from < 0) return null
    segments.push(text.slice(from, at))
    flag = prevUsed[at][flag]
    at = from
  }
  segments.reverse()
  return { cost: cost[n][used], segments }
}

export function formatReading(reading: Reading | null): string {
  if (!reading) return 'no sensible reading exists'
  return reading.segments.join(' ')
}

/**
 * Cheapest segmentation that includes `word` as a segment, and the cheapest
 * that does not. Digits are atomic, so a digit in the name does not void both.
 * `termMatches` decides which spans count as the blocked word, including leet.
 */
function forcedWithWord(
  text: string,
  lexicon: Map<string, number>,
  termMatches: (span: string) => boolean
): Reading | null {
  let best: Reading | null = null
  for (let start = 0; start < text.length; start++) {
    for (const end of endsFrom(text, start)) {
      const span = text.slice(start, end)
      if (!termMatches(span)) continue
      const leftText = text.slice(0, start)
      const rightText = text.slice(end)
      const left = leftText ? cheapest(leftText, lexicon, termMatches, false, false) : { cost: 0, segments: [] }
      const right = rightText ? cheapest(rightText, lexicon, termMatches, false, false) : { cost: 0, segments: [] }
      const segments = [
        ...(left?.segments ?? [leftText]),
        span,
        ...(right?.segments ?? [rightText]),
      ]
      const cost = (left?.cost ?? leftText.length * 4)
        + (lexicon.get(span) ?? FORCED_WORD_COST)
        + (right?.cost ?? rightText.length * 4)
      if (!best || cost < best.cost) best = { cost, segments }
    }
  }
  return best
}

export function readingsFor(
  canonicalName: string,
  lexicon: Map<string, number>,
  termMatches: (span: string) => boolean
): { withWord: Reading | null; withoutWord: Reading | null } {
  const text = canonicalName.toLowerCase().replace(/[-_.]/g, '')
  return {
    withWord: forcedWithWord(text, lexicon, termMatches),
    withoutWord: cheapest(text, lexicon, termMatches, false, false),
  }
}
