// ABOUTME: Tests for ATProto fields in Fastly KV sync payloads
// ABOUTME: Verifies KV data includes atproto_did and atproto_state

import { describe, it, expect } from 'vitest'
import type { UsernameKVData } from '../src/utils/fastly-sync'

describe('UsernameKVData with ATProto fields', () => {
  it('should include atproto fields when present', () => {
    const data: UsernameKVData = {
      pubkey: 'abc123',
      relays: ['wss://relay.damus.io'],
      status: 'active',
      atproto_did: 'did:plc:abc123',
      atproto_state: 'ready',
    }

    const json = JSON.parse(JSON.stringify(data))
    expect(json.atproto_did).toBe('did:plc:abc123')
    expect(json.atproto_state).toBe('ready')
  })

  it('should serialize null ATProto fields', () => {
    const data: UsernameKVData = {
      pubkey: 'abc123',
      relays: [],
      status: 'active',
      atproto_did: null,
      atproto_state: null,
    }

    const json = JSON.parse(JSON.stringify(data))
    expect(json.atproto_did).toBeNull()
    expect(json.atproto_state).toBeNull()
  })

  it('should omit ATProto fields when undefined', () => {
    const data: UsernameKVData = {
      pubkey: 'abc123',
      relays: [],
      status: 'active',
    }

    const json = JSON.parse(JSON.stringify(data))
    expect(json.atproto_did).toBeUndefined()
    expect(json.atproto_state).toBeUndefined()
    // Verify existing fields are still present
    expect(json.pubkey).toBe('abc123')
    expect(json.status).toBe('active')
  })

  it('should accept all valid atproto_state values', () => {
    const states: Array<UsernameKVData['atproto_state']> = ['pending', 'ready', 'failed', 'disabled', null]
    for (const state of states) {
      const data: UsernameKVData = {
        pubkey: 'abc123',
        relays: [],
        status: 'active',
        atproto_did: 'did:plc:test',
        atproto_state: state,
      }
      expect(data.atproto_state).toBe(state)
    }
  })
})
