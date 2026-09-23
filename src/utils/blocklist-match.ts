// ABOUTME: Matches a canonical username against one blocklist term, under that
// ABOUTME: term's own scope and character-substitution settings.

/**
 * Where in a name a term is allowed to match.
 *
 * Which one a term gets is a property of the term, not of how severe it is. That
 * is not a style preference, it is what the registry says: `nazi` at `anywhere`
 * catches 28 violations against 11 collisions, while `klan` and `aryan` in the
 * same severity tier catch nothing at all and collide only with ordinary
 * surnames ending in -kland and given names built on Ryan and Ann. A single
 * global setting, or one derived from a severity tier, gets one of those two
 * groups wrong.
 */
export type MatchScope = 'whole' | 'token' | 'anywhere'

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
}

export const DEFAULT_RULES: TermRules = {
  scope: 'whole',
  leet: true,
  digitExpand: false,
  repeats: false,
}

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

/** Every run of consecutive separator-delimited parts, longest first. */
function tokenRuns(name: string): string[] {
  const parts = name.split(/[-_.]/)
  const runs: string[] = []
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j <= parts.length; j++) runs.push(parts.slice(i, j).join(''))
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

  switch (rules.scope) {
    case 'whole':
      return new RegExp(`^(?:${pattern.source})$`).test(canonicalName)
    case 'token': {
      const anchored = new RegExp(`^(?:${pattern.source})$`)
      return tokenRuns(canonicalName).some((run) => anchored.test(run))
    }
    case 'anywhere':
      return pattern.test(canonicalName)
  }
}
