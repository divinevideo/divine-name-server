// ABOUTME: Matches a canonical username against one blocklist term, under that
// ABOUTME: term's own scope and character-substitution settings.

/**
 * Where in a name a term is allowed to match deterministically.
 *
 * `anywhere` is not a scope. A blocked word glued inside a longer word is not
 * a pattern the matcher can settle, so that case is `ambiguous` and goes to
 * judgment. A moderator-approved novel word sets `plain` instead, which is a
 * substring block that never needs another call.
 */
export type MatchScope = 'whole' | 'token'

export interface TermRules {
  /** Default 'whole': the safe end. A new term blocks only the name that is that term. */
  scope: MatchScope
  /**
   * Let a digit stand for the letter it imitates, so `fuck` matches `f0ck`.
   *
   * Deliberately one-directional by default: letters expand to digits. Letter-to-
   * letter equivalence (treating `i` and `l` as the same) is a trap. It makes
   * `klan` match `kian` and `nazi` match `nazl`, which lands on 93 existing
   * names, most of them ordinary Turkish and Persian given names.
   */
  leet: boolean
  /**
   * Also expand digits back to letters, for terms stored already leetspelled.
   *
   * The list holds `n1gg4` and `h1tler`. Without this, a pattern built from those
   * characters matches only the leet spelling and never the plain word. It is
   * per-term rather than global because enabling it everywhere makes numeric hate
   * codes (`1488`, `adolf88`, `under18`) match unrelated strings such as birth years.
   */
  digitExpand: boolean
  /** Tolerate a run of one character, so `bitch` matches `biiitch`. Off by default: `aryan` with repeats matches ordinary hyphenated names containing "arry-and". */
  repeats: boolean
  /**
   * Substring block. Only set when a moderator approves a proposed word after
   * seeing how many existing names it would catch. Not a scope a moderator
   * picks from the add form.
   */
  plain: boolean
}

export const DEFAULT_RULES: TermRules = {
  scope: 'whole',
  leet: true,
  digitExpand: false,
  repeats: false,
  plain: false,
}

/** Categories whose embeddings are a judgment, not a miss and not a block. */
export const JUDGED_CATEGORIES = new Set(['offensive', 'child_safety'])

/** Characters the namespace allows between parts of a name. */
const SEPARATORS = '[-_.]*'

/** Letter to the digits that imitate it. Digits only, by design; see TermRules.leet. */
const LEET: Record<string, string> = {
  a: '4', b: '8', e: '3', g: '9', i: '1', l: '1', o: '0', s: '5', t: '7', z: '2',
}

/** The reverse, for terms stored leetspelled. `1` maps back to both `i` and `l`. */
const UNLEET: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [letter, digits] of Object.entries(LEET)) {
    for (const digit of digits) out[digit] = (out[digit] ?? '') + letter
  }
  return out
})()

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The set of characters allowed at one position of a term.
 *
 * Built per position rather than by rewriting the name into a single normalized
 * form. Folding the name destroys information the next term needs, and it cannot
 * express that `1` is a valid `i` here but a literal `1` in `1488`.
 */
function positionClass(char: string, rules: TermRules): string {
  const accepted = new Set<string>([char])

  if (rules.leet && !/[0-9]/.test(char)) {
    for (const digit of LEET[char] ?? '') accepted.add(digit)
  }
  if (rules.digitExpand && /[0-9]/.test(char)) {
    for (const letter of UNLEET[char] ?? '') accepted.add(letter)
  }

  const parts = [...accepted].sort().map(escapeRegex)
  if (parts.length === 1 && !rules.repeats) return parts[0]

  // `(?:a|4)+` would accept "a4a4"; `(?:a+|4+)` only repeats one character.
  const body = rules.repeats ? parts.map((p) => `${p}+`).join('|') : parts.join('|')
  return `(?:${body})`
}

/**
 * Compiles one term to a pattern that matches the term's spelling variants.
 *
 * Cheap enough to do per request (roughly 0.25ms for all 600 terms against a
 * maximum-length name), but callers that check many names should cache by term.
 */
export function compileTerm(term: string, rules: TermRules = DEFAULT_RULES): RegExp {
  // A separator stored in the term is already allowed between every pair of
  // characters. Kept as a literal it would be required, so a hyphenated term
  // would never match its joined spelling, and could never match at `token`
  // scope, where the parts are compared with their separators removed.
  const chars = [...term].filter((char) => !/[-_.]/.test(char))
  const body = chars.map((char) => positionClass(char, rules)).join(SEPARATORS)
  return new RegExp(body)
}

function isPunycode(value: string): boolean {
  return value.startsWith('xn--')
}

/**
 * Every run of consecutive separator-delimited parts, longest first.
 *
 * A run made only of single-letter parts contributes its maximal join and not
 * the interior sub-runs. Otherwise a letter-spelled name (`q-w-e-r-t-y`) makes
 * every short blocked word inside those letters a deterministic token hit.
 * The whole run still matches, so `f-u-c-k` remains the word `fuck`.
 */
export function tokenRuns(name: string): string[] {
  const parts = name.split(/[-_.]/).filter((part) => part.length > 0)
  const runs: string[] = []
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j <= parts.length; j++) {
      const slice = parts.slice(i, j)
      if (slice.length > 1 && slice.every((part) => part.length === 1)) {
        const maximal = (i === 0 || parts[i - 1].length !== 1)
          && (j === parts.length || parts[j].length !== 1)
        if (!maximal) continue
      }
      runs.push(slice.join(''))
    }
  }
  return runs
}

/**
 * Whether `canonicalName` violates `term` under that term's rules.
 *
 * `canonicalName` must be the canonical form, which is punycode for Unicode
 * names — the same form stored in `reserved_words` and compared by
 * `isReservedWord`. A Unicode term compared against a display form would never
 * match the name it is meant to block.
 */
export function matchesTerm(
  canonicalName: string,
  term: string,
  rules: TermRules = DEFAULT_RULES,
  compiled?: RegExp
): boolean {
  // Punycode is an encoding, not spelling. Its hyphens are structure rather
  // than separators, and its trailing characters encode code points rather than
  // letters, so splitting it into parts, reading digits as letters, or looking
  // inside it matches unrelated names. Either side in punycode compares exactly,
  // as every term did before these rules existed. Unicode look-alikes are #48.
  if (isPunycode(canonicalName) || isPunycode(term)) return canonicalName === term

  const pattern = compiled ?? compileTerm(term, rules)
  if (rules.plain && pattern.test(canonicalName)) return true

  switch (rules.scope) {
    case 'whole':
      return new RegExp(`^(?:${pattern.source})$`).test(canonicalName)
    case 'token': {
      const anchored = new RegExp(`^(?:${pattern.source})$`)
      return tokenRuns(canonicalName).some((run) => anchored.test(run))
    }
  }
}

export type TermSignal = 'blocked' | 'ambiguous' | 'clear'

/**
 * `blocked` when the term matches at its scope (or as a plain substring).
 * `ambiguous` when a judged term's letters sit inside a longer name but do not
 * match at that scope. `clear` otherwise. Punycode is never ambiguous.
 */
export function termSignal(
  canonicalName: string,
  term: string,
  rules: TermRules = DEFAULT_RULES,
  judgeEmbeddings = false,
  compiled?: RegExp
): TermSignal {
  if (matchesTerm(canonicalName, term, rules, compiled)) return 'blocked'
  if (!judgeEmbeddings || isPunycode(canonicalName) || isPunycode(term)) return 'clear'
  const pattern = compiled ?? compileTerm(term, rules)
  return pattern.test(canonicalName) ? 'ambiguous' : 'clear'
}

export interface ListedTerm {
  word: string
  rules: TermRules
  judgeEmbeddings: boolean
}

export interface NameClassification {
  verdict: TermSignal
  blocked: string[]
  embedded: string[]
}

/** Blocked wins. Embedded words are longest-first so the caller asks about the specific one first. */
export function classifyName(canonicalName: string, terms: ListedTerm[]): NameClassification {
  const blocked: string[] = []
  const embedded: string[] = []
  for (const term of terms) {
    const signal = termSignal(canonicalName, term.word, term.rules, term.judgeEmbeddings)
    if (signal === 'blocked') blocked.push(term.word)
    else if (signal === 'ambiguous') embedded.push(term.word)
  }
  embedded.sort((a, b) => b.length - a.length || a.localeCompare(b))
  if (blocked.length > 0) return { verdict: 'blocked', blocked, embedded }
  if (embedded.length > 0) return { verdict: 'ambiguous', blocked, embedded }
  return { verdict: 'clear', blocked, embedded }
}
