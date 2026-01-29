// ABOUTME: Tests for username and pubkey validation logic
// ABOUTME: Ensures usernames meet format requirements and pubkeys accept hex/npub

import { describe, it, expect } from 'vitest'
import { validateUsername, UsernameValidationError, validateRelays, RelayValidationError, validateAndNormalizePubkey, PubkeyValidationError } from './validation'

describe('validateUsername', () => {
  describe('valid usernames', () => {
    it('should accept single character', () => {
      const result = validateUsername('a')
      expect(result.display).toBe('a')
      expect(result.canonical).toBe('a')
    })

    it('should accept single uppercase character', () => {
      const result = validateUsername('A')
      expect(result.display).toBe('A')
      expect(result.canonical).toBe('a')
    })

    it('should accept lowercase usernames', () => {
      const result = validateUsername('alice')
      expect(result.display).toBe('alice')
      expect(result.canonical).toBe('alice')
    })

    it('should accept mixed case usernames', () => {
      const result = validateUsername('MrBeast')
      expect(result.display).toBe('MrBeast')
      expect(result.canonical).toBe('mrbeast')
    })

    it('should accept usernames with numbers', () => {
      const result = validateUsername('bob123')
      expect(result.display).toBe('bob123')
      expect(result.canonical).toBe('bob123')
    })

    it('should accept usernames with hyphens', () => {
      const result = validateUsername('m-r-beast-123')
      expect(result.display).toBe('m-r-beast-123')
      expect(result.canonical).toBe('m-r-beast-123')
    })

    it('should accept single digit', () => {
      const result = validateUsername('0')
      expect(result.display).toBe('0')
      expect(result.canonical).toBe('0')
    })

    it('should accept 63 character username (DNS limit)', () => {
      const longName = 'a'.repeat(63)
      const result = validateUsername(longName)
      expect(result.display).toBe(longName)
      expect(result.canonical).toBe(longName)
    })

    it('should trim whitespace', () => {
      const result = validateUsername('  alice  ')
      expect(result.display).toBe('alice')
      expect(result.canonical).toBe('alice')
    })
  })

  describe('invalid usernames', () => {
    it('should reject empty string', () => {
      expect(() => validateUsername('')).toThrow(UsernameValidationError)
      expect(() => validateUsername('')).toThrow('Username is required')
    })

    it('should reject whitespace only', () => {
      expect(() => validateUsername('   ')).toThrow(UsernameValidationError)
      expect(() => validateUsername('   ')).toThrow('Username is required')
    })

    it('should reject usernames longer than 63 characters', () => {
      const longName = 'a'.repeat(64)
      expect(() => validateUsername(longName)).toThrow(UsernameValidationError)
      expect(() => validateUsername(longName)).toThrow('1–63 characters')
    })

    it('should reject usernames with underscores', () => {
      expect(() => validateUsername('ab_')).toThrow(UsernameValidationError)
      expect(() => validateUsername('ab_')).toThrow('underscores')
    })

    it('should reject usernames with dots', () => {
      expect(() => validateUsername('ab.cd')).toThrow(UsernameValidationError)
      expect(() => validateUsername('ab.cd')).toThrow('dots')
    })

    it('should reject usernames starting with hyphen', () => {
      expect(() => validateUsername('-abc')).toThrow(UsernameValidationError)
      expect(() => validateUsername('-abc')).toThrow("can't start or end with a hyphen")
    })

    it('should reject usernames ending with hyphen', () => {
      expect(() => validateUsername('abc-')).toThrow(UsernameValidationError)
      expect(() => validateUsername('abc-')).toThrow("can't start or end with a hyphen")
    })

    it('should reject usernames with spaces', () => {
      expect(() => validateUsername('a b')).toThrow(UsernameValidationError)
      expect(() => validateUsername('a b')).toThrow('spaces')
    })

    it('should reject usernames with emojis', () => {
      expect(() => validateUsername('abc😀')).toThrow(UsernameValidationError)
      expect(() => validateUsername('abc😀')).toThrow('emojis')
    })

    it('should allow multiple consecutive hyphens in middle', () => {
      const result = validateUsername('a--b')
      expect(result.display).toBe('a--b')
      expect(result.canonical).toBe('a--b')
    })
  })

  describe('canonicalization', () => {
    it('should preserve case in display but lowercase canonical', () => {
      const result = validateUsername('MrBeast')
      expect(result.display).toBe('MrBeast')
      expect(result.canonical).toBe('mrbeast')
    })

    it('should handle all uppercase', () => {
      const result = validateUsername('ALICE')
      expect(result.display).toBe('ALICE')
      expect(result.canonical).toBe('alice')
    })

    it('should handle mixed case with hyphens', () => {
      const result = validateUsername('Mr-Beast-123')
      expect(result.display).toBe('Mr-Beast-123')
      expect(result.canonical).toBe('mr-beast-123')
    })
  })

  describe('internationalized domain names (IDN)', () => {
    it('should accept Japanese characters', () => {
      const result = validateUsername('日本語')
      expect(result.display).toBe('日本語')
      expect(result.canonical).toBe('xn--wgv71a119e')
    })

    it('should accept Chinese characters', () => {
      const result = validateUsername('中文')
      expect(result.display).toBe('中文')
      expect(result.canonical).toBe('xn--fiq228c')
    })

    it('should accept Korean characters', () => {
      const result = validateUsername('한국어')
      expect(result.display).toBe('한국어')
      expect(result.canonical).toMatch(/^xn--/)
    })

    it('should accept Thai characters', () => {
      const result = validateUsername('ไทย')
      expect(result.display).toBe('ไทย')
      expect(result.canonical).toBe('xn--o3cw4h')
    })

    it('should accept Arabic characters', () => {
      const result = validateUsername('عربي')
      expect(result.display).toBe('عربي')
      expect(result.canonical).toBe('xn--ngbrx4e')
    })

    it('should accept Cyrillic characters', () => {
      const result = validateUsername('русский')
      expect(result.display).toBe('русский')
      expect(result.canonical).toMatch(/^xn--/)
    })

    it('should accept German umlauts', () => {
      const result = validateUsername('münchen')
      expect(result.display).toBe('münchen')
      expect(result.canonical).toBe('xn--mnchen-3ya')
    })

    it('should accept accented Latin characters', () => {
      const result = validateUsername('café')
      expect(result.display).toBe('café')
      expect(result.canonical).toBe('xn--caf-dma')
    })

    it('should accept mixed Unicode and ASCII', () => {
      const result = validateUsername('user日本')
      expect(result.display).toBe('user日本')
      expect(result.canonical).toMatch(/^xn--/)
    })

    it('should accept Unicode with hyphens', () => {
      const result = validateUsername('日本-語')
      expect(result.display).toBe('日本-語')
      // Hyphen is preserved in punycode encoding
      expect(result.canonical).toMatch(/^xn--/)
    })

    it('should reject Unicode starting with hyphen', () => {
      expect(() => validateUsername('-日本語')).toThrow(UsernameValidationError)
      expect(() => validateUsername('-日本語')).toThrow("can't start or end with a hyphen")
    })

    it('should reject Unicode ending with hyphen', () => {
      expect(() => validateUsername('日本語-')).toThrow(UsernameValidationError)
      expect(() => validateUsername('日本語-')).toThrow("can't start or end with a hyphen")
    })

    it('should reject punycode that exceeds 63 characters', () => {
      // Very long Unicode string that would exceed 63 chars in punycode
      const longUnicode = '日本語'.repeat(20)
      expect(() => validateUsername(longUnicode)).toThrow(UsernameValidationError)
      expect(() => validateUsername(longUnicode)).toThrow('too long')
    })

    it('should reject invalid Unicode combining sequences', () => {
      // Zero-width joiner without proper context
      expect(() => validateUsername('a\u200Db')).toThrow(UsernameValidationError)
    })

    it('should reject usernames with only combining marks', () => {
      // Combining diacritical marks without base character
      expect(() => validateUsername('\u0300\u0301')).toThrow(UsernameValidationError)
    })

    it('should handle single Unicode character', () => {
      const result = validateUsername('中')
      expect(result.display).toBe('中')
      expect(result.canonical).toBe('xn--fiq')
    })

    it('should reject ASCII hyphens at positions 3-4 (reserved for ACE prefix)', () => {
      // "ab--cd" has hyphens at positions 3 and 4, which is reserved for punycode
      expect(() => validateUsername('ab--cd')).toThrow(UsernameValidationError)
      expect(() => validateUsername('ab--cd')).toThrow('positions 3 and 4')
    })

    it('should allow hyphens at other positions', () => {
      const result = validateUsername('a--bcd')
      expect(result.display).toBe('a--bcd')
      expect(result.canonical).toBe('a--bcd')
    })

    it('should allow hyphens after position 4', () => {
      const result = validateUsername('abcd--ef')
      expect(result.display).toBe('abcd--ef')
      expect(result.canonical).toBe('abcd--ef')
    })
  })
})

describe('validateRelays', () => {
  it('should accept null relays', () => {
    expect(() => validateRelays(null)).not.toThrow()
  })

  it('should accept empty array', () => {
    expect(() => validateRelays([])).not.toThrow()
  })

  it('should accept valid wss URLs', () => {
    const relays = [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net'
    ]
    expect(() => validateRelays(relays)).not.toThrow()
  })

  it('should reject non-wss URLs', () => {
    expect(() => validateRelays(['https://example.com'])).toThrow(RelayValidationError)
    expect(() => validateRelays(['ws://relay.com'])).toThrow(RelayValidationError)
  })

  it('should reject more than 50 relays', () => {
    const tooMany = Array(51).fill('wss://relay.com')
    expect(() => validateRelays(tooMany)).toThrow(RelayValidationError)
    expect(() => validateRelays(tooMany)).toThrow('Maximum 50 relays')
  })

  it('should reject URLs longer than 200 characters', () => {
    const longUrl = 'wss://' + 'a'.repeat(200) + '.com'
    expect(() => validateRelays([longUrl])).toThrow(RelayValidationError)
  })

  it('should reject invalid URL format', () => {
    expect(() => validateRelays(['not a url'])).toThrow(RelayValidationError)
  })
})

describe('validateAndNormalizePubkey', () => {
  const validHex = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'
  const validNpub = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6'

  it('should accept valid 64-character hex pubkey', () => {
    const result = validateAndNormalizePubkey(validHex)
    expect(result).toBe(validHex)
  })

  it('should accept uppercase hex and normalize to lowercase', () => {
    const upperHex = validHex.toUpperCase()
    const result = validateAndNormalizePubkey(upperHex)
    expect(result).toBe(validHex)
  })

  it('should accept valid npub format and convert to hex', () => {
    const result = validateAndNormalizePubkey(validNpub)
    expect(result).toBe(validHex)
  })

  it('should accept npub with whitespace and trim it', () => {
    const result = validateAndNormalizePubkey(`  ${validNpub}  `)
    expect(result).toBe(validHex)
  })

  it('should reject empty pubkey', () => {
    expect(() => validateAndNormalizePubkey('')).toThrow(PubkeyValidationError)
  })

  it('should reject hex pubkey with wrong length', () => {
    expect(() => validateAndNormalizePubkey('3bf0c63fcb93463407af97a5e5ee64fa')).toThrow(PubkeyValidationError)
    expect(() => validateAndNormalizePubkey('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d00')).toThrow(PubkeyValidationError)
  })

  it('should reject hex with invalid characters', () => {
    expect(() => validateAndNormalizePubkey('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa45zz')).toThrow(PubkeyValidationError)
  })

  it('should reject invalid npub format', () => {
    expect(() => validateAndNormalizePubkey('npub1invalid')).toThrow(PubkeyValidationError)
  })

  it('should reject nsec (private key) format', () => {
    expect(() => validateAndNormalizePubkey('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5')).toThrow(PubkeyValidationError)
  })

  it('should reject random strings', () => {
    expect(() => validateAndNormalizePubkey('not-a-pubkey')).toThrow(PubkeyValidationError)
  })
})
