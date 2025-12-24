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
      expect(() => validateUsername('ab_')).toThrow('letters, numbers, and hyphens')
    })

    it('should reject usernames with dots', () => {
      expect(() => validateUsername('ab.cd')).toThrow(UsernameValidationError)
      expect(() => validateUsername('ab.cd')).toThrow('letters, numbers, and hyphens')
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
      expect(() => validateUsername('a b')).toThrow('letters, numbers, and hyphens')
    })

    it('should reject usernames with unicode characters', () => {
      expect(() => validateUsername('äbc')).toThrow(UsernameValidationError)
      expect(() => validateUsername('äbc')).toThrow('letters, numbers, and hyphens')
    })

    it('should reject usernames with emojis', () => {
      expect(() => validateUsername('abc😀')).toThrow(UsernameValidationError)
      expect(() => validateUsername('abc😀')).toThrow('letters, numbers, and hyphens')
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
