// ABOUTME: Tests for username and pubkey validation logic
// ABOUTME: Ensures usernames meet format requirements and pubkeys accept hex/npub

import { describe, it, expect } from 'vitest'
import { validateUsername, UsernameValidationError, validateRelays, RelayValidationError, validateAndNormalizePubkey, PubkeyValidationError } from './validation'

describe('validateUsername', () => {
  it('should accept valid lowercase alphanumeric usernames', () => {
    expect(() => validateUsername('alice')).not.toThrow()
    expect(() => validateUsername('bob123')).not.toThrow()
    expect(() => validateUsername('user2024')).not.toThrow()
  })

  it('should reject usernames shorter than 3 characters', () => {
    expect(() => validateUsername('ab')).toThrow(UsernameValidationError)
    expect(() => validateUsername('ab')).toThrow('must be 3-20 characters')
  })

  it('should reject usernames longer than 20 characters', () => {
    expect(() => validateUsername('a'.repeat(21))).toThrow(UsernameValidationError)
    expect(() => validateUsername('a'.repeat(21))).toThrow('must be 3-20 characters')
  })

  it('should reject usernames with uppercase letters', () => {
    expect(() => validateUsername('Alice')).toThrow(UsernameValidationError)
    expect(() => validateUsername('Alice')).toThrow('lowercase alphanumeric')
  })

  it('should reject usernames with special characters', () => {
    expect(() => validateUsername('alice_123')).toThrow(UsernameValidationError)
    expect(() => validateUsername('alice-bob')).toThrow(UsernameValidationError)
    expect(() => validateUsername('alice.bob')).toThrow(UsernameValidationError)
  })

  it('should reject empty usernames', () => {
    expect(() => validateUsername('')).toThrow(UsernameValidationError)
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
