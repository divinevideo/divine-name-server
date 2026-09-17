// ABOUTME: Guards the shared username form rule against the bug class in #89/#92
// ABOUTME: The pattern must compile under both regex flags and match the server's ASCII rule

import { describe, it, expect } from 'vitest'
import { USERNAME_INPUT_PATTERN, USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH } from './username'

// The browser compiles a form's `pattern` as `^(?:<pattern>)$`. Reproduce that
// exactly so the test sees what the browser sees.
function compile(flag: 'u' | 'v'): RegExp {
  return new RegExp(`^(?:${USERNAME_INPUT_PATTERN})$`, flag)
}

describe('USERNAME_INPUT_PATTERN', () => {
  // #92 was an unescaped hyphen that is a syntax error under the `v` flag
  // browsers now use; an uncompilable pattern is ignored, silently disabling the
  // check. It must compile under both the old `u` and current `v` flags.
  it.each(['u', 'v'] as const)('compiles as a form pattern under the %s flag', (flag) => {
    expect(() => compile(flag)).not.toThrow()
  })

  it('behaves identically under both flags', () => {
    const u = compile('u')
    const v = compile('v')
    for (const s of ['alice', 'a-b', 'MrBeast', 'three-part-name', '-lead', 'trail-', 'a']) {
      expect(u.test(s), `${s} under u`).toBe(v.test(s))
    }
  })

  describe('accepts names the server issues', () => {
    it.each([
      'alice',
      'a-b',              // hyphen: the #89/#92 case
      'MrBeast',          // uppercase: Revoke rejected these before #95
      'three-part-name',  // multi-segment hyphens
      'a',                // single char (min length)
      'a'.repeat(63),     // max length
    ])('accepts %j', (name) => {
      expect(compile('v').test(name)).toBe(true)
    })
  })

  describe('rejects what the server rejects', () => {
    it.each([
      '-leading',
      'trailing-',
      'has space',
      'under_score',
      'dot.name',
      'café',             // form is ASCII-only; server takes Unicode (#93), so form is narrower here
      'a'.repeat(64),     // over max length
    ])('rejects %j', (name) => {
      expect(compile('v').test(name)).toBe(false)
    })
  })

  it('has length bounds matching the server (1..63)', () => {
    expect(USERNAME_MIN_LENGTH).toBe(1)
    expect(USERNAME_MAX_LENGTH).toBe(63)
  })
})
