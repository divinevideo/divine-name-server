// ABOUTME: Tests for username validation logic
// ABOUTME: Ensures usernames meet format requirements and aren't reserved

import { describe, it, expect } from 'vitest'
import { validateUsername, UsernameValidationError, validateRelays, RelayValidationError } from './validation'

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
