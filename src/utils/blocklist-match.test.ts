// ABOUTME: Covers the matcher's scope and substitution rules, and the specific
// ABOUTME: collisions measured against the live registry that motivated each one.

import { describe, it, expect } from 'vitest'
import { compileTerm, matchesTerm, DEFAULT_RULES, type TermRules } from './blocklist-match'

const rules = (over: Partial<TermRules> = {}): TermRules => ({ ...DEFAULT_RULES, ...over })

describe('scope', () => {
  it('whole matches only the name that is the term', () => {
    const r = rules({ scope: 'whole' })
    expect(matchesTerm('admin', 'admin', r)).toBe(true)
    expect(matchesTerm('myadmin', 'admin', r)).toBe(false)
    expect(matchesTerm('xx-admin-xx', 'admin', r)).toBe(false)
  })

  it('whole still sees separators inside the term, which is the reported bug', () => {
    const r = rules({ scope: 'whole' })
    expect(matchesTerm('ad-min', 'admin', r)).toBe(true)
    expect(matchesTerm('a-d-m-i-n', 'admin', r)).toBe(true)
  })

  it('token matches a run of whole parts', () => {
    const r = rules({ scope: 'token' })
    expect(matchesTerm('xx-admin-xx', 'admin', r)).toBe(true)
    expect(matchesTerm('ad-min-panel', 'admin', r)).toBe(true)
    expect(matchesTerm('myadmin', 'admin', r)).toBe(false)
  })

  it('anywhere matches inside a word', () => {
    const r = rules({ scope: 'anywhere' })
    expect(matchesTerm('myadmin', 'admin', r)).toBe(true)
    expect(matchesTerm('badminton', 'admin', r)).toBe(true)
  })

  it('token does not fire on a name that merely contains the letters', () => {
    // `badminton` is one part, so no run of parts equals `admin`.
    expect(matchesTerm('badminton', 'admin', rules({ scope: 'token' }))).toBe(false)
  })
})

describe('digit substitution', () => {
  it('lets a digit stand for the letter it imitates', () => {
    expect(matchesTerm('f0ck', 'fock', rules({ scope: 'whole' }))).toBe(true)
    expect(matchesTerm('4ryan', 'aryan', rules({ scope: 'whole' }))).toBe(true)
  })

  it('does not treat letters as equivalent to each other', () => {
    // The trap: allowing i and l to substitute makes `klan` match `kian` and
    // `nazi` match `nazl`, which lands on 93 names already in the namespace,
    // mostly ordinary Turkish and Persian given names.
    expect(matchesTerm('kiarn', 'klan', rules({ scope: 'anywhere' }))).toBe(false)
    expect(matchesTerm('nazl', 'nazi', rules({ scope: 'anywhere' }))).toBe(false)
    expect(matchesTerm('kian-x', 'klan', rules({ scope: 'anywhere' }))).toBe(false)
  })

  it('leaves digits literal unless the term opts into expansion', () => {
    // Numeric hate codes must not drift onto unrelated strings.
    expect(matchesTerm('1488', '1488', rules({ scope: 'whole' }))).toBe(true)
    expect(matchesTerm('iabb', '1488', rules({ scope: 'anywhere' }))).toBe(false)
    expect(matchesTerm('underib', 'under18', rules({ scope: 'anywhere' }))).toBe(false)
  })
})

describe('terms stored leetspelled', () => {
  it('matches the plain spelling only when digit expansion is on', () => {
    // The list holds `h1tler`. Without expansion it matches only itself, which
    // is how a real attempted name got through.
    expect(matchesTerm('hitler', 'h1tler', rules({ scope: 'anywhere' }))).toBe(false)
    expect(matchesTerm('hitler', 'h1tler', rules({ scope: 'anywhere', digitExpand: true }))).toBe(true)
  })

  it('expands a digit to every letter it could be', () => {
    // `1` has to reach both `i` and `l`, or `n1gg4` misses `nigga`.
    const r = rules({ scope: 'anywhere', digitExpand: true })
    expect(matchesTerm('nigga', 'n1gg4', r)).toBe(true)
    expect(matchesTerm('n1gg4', 'n1gg4', r)).toBe(true)
  })
})

describe('repeat tolerance', () => {
  it('absorbs a run of one character when enabled', () => {
    expect(matchesTerm('biiitch', 'bitch', rules({ scope: 'anywhere', repeats: true }))).toBe(true)
    expect(matchesTerm('biiitch', 'bitch', rules({ scope: 'anywhere' }))).toBe(false)
  })

  it('does not let equivalent characters alternate', () => {
    // A naive `(?:i|1|l)+` would accept `hili1l` for `hi`.
    expect(matchesTerm('hili1l', 'hi', rules({ scope: 'whole', repeats: true }))).toBe(false)
  })
})

describe('collisions of the kind that make scope per-term', () => {
  it('keeps ordinary names that merely contain a term as a substring', () => {
    // The shapes below are why several terms cannot be loosened. Each stands for
    // a group of legitimate names already in the namespace: transliterated Arabic
    // and Spanish given names where "an" meets "al", surnames ending in -cock or
    // -kland, and ordinary English words. At `anywhere`, `anal` alone would take
    // 165 registered accounts to catch 8 violations, and `rape` would take 66 to
    // catch 2.
    const cases: Array<[string, string]> = [
      ['hassan-alvarez', 'anal'],
      ['joanna-lisbon', 'anal'],
      ['brian-alexander', 'anal'],
      ['canal-street', 'anal'],
      ['grapevine-co', 'rape'],
      ['draper-media', 'rape'],
      ['wilcock', 'cock'],
      ['woodcock-house', 'cock'],
      ['parkland-news', 'klan'],
      ['strickland-and-co', 'klan'],
      ['caryanne-b', 'aryan'],
      ['butitsfine', 'tits'],
    ]
    for (const [name, term] of cases) {
      expect(matchesTerm(name, term, rules({ scope: 'token' })), `${term} vs ${name}`).toBe(false)
    }
  })

  it('still catches the deliberate spellings those terms exist for', () => {
    expect(matchesTerm('f-u-c-k', 'fuck', rules({ scope: 'whole' }))).toBe(true)
    expect(matchesTerm('fu-ck', 'fuck', rules({ scope: 'whole' }))).toBe(true)
    expect(matchesTerm('xx-nazi-xx', 'nazi', rules({ scope: 'token' }))).toBe(true)
    expect(matchesTerm('blahcock', 'cock', rules({ scope: 'anywhere' }))).toBe(true)
  })
})

describe('compiled patterns', () => {
  it('is safe to reuse a compiled pattern across names', () => {
    const compiled = compileTerm('admin', rules({ scope: 'anywhere' }))
    const r = rules({ scope: 'anywhere' })
    expect(matchesTerm('myadmin', 'admin', r, compiled)).toBe(true)
    expect(matchesTerm('myadmin', 'admin', r, compiled)).toBe(true)
    expect(matchesTerm('nothing', 'admin', r, compiled)).toBe(false)
  })

  it('handles the longest name the namespace allows without pathological cost', () => {
    const name = 'a'.repeat(63)
    const start = Date.now()
    for (let i = 0; i < 200; i++) {
      matchesTerm(name, 'admin', rules({ scope: 'anywhere', repeats: true }))
    }
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
