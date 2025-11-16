// ABOUTME: Tests for NIP-98 HTTP authentication verification
// ABOUTME: Validates Nostr event signatures on HTTP requests

import { describe, it, expect } from 'vitest'
import { verifyNip98Event } from './nip98'

describe('verifyNip98Event', () => {
  it('should reject if Authorization header missing', async () => {
    const headers = new Headers()
    await expect(verifyNip98Event(headers, 'GET', 'https://example.com/api'))
      .rejects.toThrow('Missing Authorization header')
  })

  it('should reject if not Nostr auth scheme', async () => {
    const headers = new Headers()
    headers.set('Authorization', 'Bearer token123')
    await expect(verifyNip98Event(headers, 'GET', 'https://example.com/api'))
      .rejects.toThrow('Invalid Authorization scheme')
  })

  // More comprehensive tests would require generating valid Nostr events
  // For now, we verify the basic structure works
})
