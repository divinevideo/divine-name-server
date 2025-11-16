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

  it('should accept optional body parameter for POST requests', async () => {
    const headers = new Headers()
    headers.set('Authorization', 'Nostr invalidbase64')
    // This will fail on JSON parsing, but it shows the signature accepts body parameter
    await expect(verifyNip98Event(headers, 'POST', 'https://example.com/api', '{"test":"data"}'))
      .rejects.toThrow('Invalid base64 or JSON')
  })

  // More comprehensive tests would require generating valid Nostr events
  // For now, we verify the basic structure works
})
