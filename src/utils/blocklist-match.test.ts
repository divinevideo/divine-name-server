// ABOUTME: Covers the matcher's scope and substitution rules, and the specific
// ABOUTME: collisions measured against the live registry that motivated each one.

import { describe, it, expect } from 'vitest'
import { compileTerm, matchesTerm, termSignal, tokenRuns, DEFAULT_RULES, type TermRules } from './blocklist-match'

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

  it('does not block a word glued inside a longer name', () => {
    const r = rules({ scope: 'token' })
    expect(matchesTerm('myadmin', 'admin', r)).toBe(false)
    expect(termSignal('myadmin', 'admin', r, true)).toBe('ambiguous')
    expect(termSignal('badminton', 'admin', r, false)).toBe('clear')
  })

  it('plain substring match is the approved-word exception', () => {
    const r = rules({ scope: 'token', plain: true })
    expect(matchesTerm('myadmin', 'admin', r)).toBe(true)
    expect(termSignal('myadmin', 'admin', r, true)).toBe('blocked')
  })

  it('a run of single letters matches only as a whole, not inside a spelled name', () => {
    const r = rules({ scope: 'token' })
    expect(tokenRuns('f-u-c-k')).toContain('fuck')
    expect(tokenRuns('f-u-c-k')).not.toContain('uc')
    expect(matchesTerm('f-u-c-k', 'fuck', r)).toBe(true)
    expect(matchesTerm('q-w-e-r-t-y', 'ert', r)).toBe(false)
    expect(termSignal('q-w-e-r-t-y', 'ert', r, true)).toBe('ambiguous')
    expect(matchesTerm('xx-f-u-c-k', 'fuck', r)).toBe(true)
  })

  it('treats a separator stored in the term like any other separator', () => {
    // A hyphenated term matches itself and its joined spelling at every scope.
    for (const scope of ['whole', 'token'] as const) {
      const r = rules({ scope })
      expect(matchesTerm('big-bad-word', 'big-bad-word', r), scope).toBe(true)
      expect(matchesTerm('bigbadword', 'big-bad-word', r), scope).toBe(true)
      expect(matchesTerm('big.bad_word', 'big-bad-word', r), scope).toBe(true)
    }
    expect(matchesTerm('xx-big-bad-word', 'big-bad-word', rules({ scope: 'token' }))).toBe(true)
    expect(matchesTerm('xxbigbadword', 'big-bad-word', rules({ scope: 'token' }))).toBe(false)
  })

  it('token does not fire on a name that merely contains the letters', () => {
    // `badminton` is one part, so no run of parts equals `admin`.
    expect(matchesTerm('badminton', 'admin', rules({ scope: 'token' }))).toBe(false)
  })
})

describe('punycode', () => {
  it('matches a punycode name only when the whole name is the term', () => {
    // `xn--caf-dma` is café. Its hyphens and tail are encoding, not words.
    for (const scope of ['whole', 'token'] as const) {
      const r = rules({ scope })
      expect(matchesTerm('xn--caf-dma', 'dma', r), scope).toBe(false)
      expect(matchesTerm('xn--caf-dma', 'caf', r), scope).toBe(false)
      expect(termSignal('xn--caf-dma', 'caf', r, true), scope).toBe('clear')
    }
  })

  it('compares a punycode term exactly, without substitution or separators', () => {
    for (const scope of ['whole', 'token'] as const) {
      const r = rules({ scope, repeats: true, digitExpand: true })
      expect(matchesTerm('xn--vusz0j', 'xn--vusz0j', r), scope).toBe(true)
      expect(matchesTerm('xn--vu5z0j', 'xn--vusz0j', r), scope).toBe(false)
      expect(matchesTerm('xnvusz0j', 'xn--vusz0j', r), scope).toBe(false)
      expect(matchesTerm('xx-xn--vusz0j', 'xn--vusz0j', r), scope).toBe(false)
    }
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
    expect(matchesTerm('kiarn', 'klan', rules({ plain: true }))).toBe(false)
    expect(matchesTerm('nazl', 'nazi', rules({ plain: true }))).toBe(false)
    expect(matchesTerm('kian-x', 'klan', rules({ plain: true }))).toBe(false)
  })

  it('leaves digits literal unless the term opts into expansion', () => {
    // Numeric hate codes must not drift onto unrelated strings.
    expect(matchesTerm('1488', '1488', rules({ scope: 'whole' }))).toBe(true)
    expect(matchesTerm('iabb', '1488', rules({ plain: true }))).toBe(false)
    expect(matchesTerm('underib', 'under18', rules({ plain: true }))).toBe(false)
  })
})

describe('terms stored leetspelled', () => {
  it('matches the plain spelling only when digit expansion is on', () => {
    // The list holds `h1tler`. Without expansion it matches only itself, which
    // is how a real attempted name got through.
    expect(matchesTerm('hitler', 'h1tler', rules({ plain: true }))).toBe(false)
    expect(matchesTerm('hitler', 'h1tler', rules({ plain: true, digitExpand: true }))).toBe(true)
  })

  it('expands a digit to every letter it could be', () => {
    // `1` has to reach both `i` and `l`, or `n1gg4` misses `nigga`.
    const r = rules({ plain: true, digitExpand: true })
    expect(matchesTerm('nigga', 'n1gg4', r)).toBe(true)
    expect(matchesTerm('n1gg4', 'n1gg4', r)).toBe(true)
  })
})

describe('repeat tolerance', () => {
  it('absorbs a run of one character when enabled', () => {
    expect(matchesTerm('biiitch', 'bitch', rules({ plain: true, repeats: true }))).toBe(true)
    expect(matchesTerm('biiitch', 'bitch', rules({ plain: true }))).toBe(false)
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
    expect(termSignal('blahcock', 'cock', rules({ scope: 'token' }), true)).toBe('ambiguous')
  })
})

describe('compiled patterns', () => {
  it('is safe to reuse a compiled pattern across names', () => {
    const compiled = compileTerm('admin', rules({ plain: true }))
    const r = rules({ plain: true })
    expect(matchesTerm('myadmin', 'admin', r, compiled)).toBe(true)
    expect(matchesTerm('myadmin', 'admin', r, compiled)).toBe(true)
    expect(matchesTerm('nothing', 'admin', r, compiled)).toBe(false)
  })

  it('handles the longest name the namespace allows without pathological cost', () => {
    const name = 'a'.repeat(63)
    const start = Date.now()
    for (let i = 0; i < 200; i++) {
      matchesTerm(name, 'admin', rules({ plain: true, repeats: true }))
    }
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
