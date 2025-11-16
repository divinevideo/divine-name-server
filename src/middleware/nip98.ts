// ABOUTME: NIP-98 HTTP authentication verification middleware
// ABOUTME: Validates Nostr event signatures for API authentication

import { schnorr } from '@noble/secp256k1'
import { bytesToHex } from '@noble/secp256k1'

export class Nip98Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Nip98Error'
  }
}

interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

function sha256(data: Uint8Array): Promise<Uint8Array> {
  return crypto.subtle.digest('SHA-256', data).then(buf => new Uint8Array(buf))
}

async function calculateEventId(event: NostrEvent): Promise<string> {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ])
  const hash = await sha256(new TextEncoder().encode(serialized))
  return bytesToHex(hash)
}

export async function verifyNip98Event(
  headers: Headers,
  method: string,
  url: string,
  body?: string
): Promise<string> {
  const authHeader = headers.get('Authorization')

  if (!authHeader) {
    throw new Nip98Error('Missing Authorization header')
  }

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Nostr') {
    throw new Nip98Error('Invalid Authorization scheme, expected: Nostr <base64-event>')
  }

  let event: NostrEvent
  try {
    const eventJson = atob(parts[1])
    event = JSON.parse(eventJson)
  } catch {
    throw new Nip98Error('Invalid base64 or JSON in Authorization header')
  }

  // Verify event structure
  if (event.kind !== 27235) {
    throw new Nip98Error('Invalid event kind, expected 27235 for NIP-98')
  }

  // Verify content is empty (NIP-98 spec says content SHOULD be empty)
  if (event.content !== '') {
    throw new Nip98Error('Event content must be empty for NIP-98')
  }

  // Verify event ID
  const calculatedId = await calculateEventId(event)
  if (calculatedId !== event.id) {
    throw new Nip98Error('Event ID does not match calculated hash')
  }

  // Verify signature
  try {
    const isValid = await schnorr.verify(
      event.sig,
      event.id,
      event.pubkey
    )
    if (!isValid) {
      throw new Nip98Error('Invalid signature')
    }
  } catch (error) {
    // Don't leak crypto library internals
    if (error instanceof Nip98Error) {
      throw error
    }
    throw new Nip98Error('Signature verification failed')
  }

  // Verify timestamp (within 60 seconds)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - event.created_at) > 60) {
    throw new Nip98Error('Event timestamp too old or in future')
  }

  // Verify method tag
  const methodTag = event.tags.find(tag => tag[0] === 'method')
  if (!methodTag || methodTag[1] !== method) {
    throw new Nip98Error(`Method tag mismatch, expected ${method}`)
  }

  // Verify URL tag
  const urlTag = event.tags.find(tag => tag[0] === 'u')
  if (!urlTag || urlTag[1] !== url) {
    throw new Nip98Error('URL tag mismatch')
  }

  // Verify payload hash for POST/PUT/PATCH methods if payload tag is present
  const payloadTag = event.tags.find(tag => tag[0] === 'payload')
  if (payloadTag) {
    if (!body) {
      throw new Nip98Error('Payload tag present but no request body provided')
    }
    const bodyHash = await sha256(new TextEncoder().encode(body))
    const bodyHashHex = bytesToHex(bodyHash)
    if (payloadTag[1] !== bodyHashHex) {
      throw new Nip98Error('Payload hash mismatch')
    }
  } else if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    // If there's a body for POST/PUT/PATCH but no payload tag, that's suspicious
    // but NIP-98 says payload tag is optional, so we'll allow it
  }

  return event.pubkey
}
