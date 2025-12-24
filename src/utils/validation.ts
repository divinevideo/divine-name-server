// ABOUTME: Username and pubkey validation utilities for format checking
// ABOUTME: Enforces 3-20 char lowercase alphanumeric requirement and pubkey formats

import { bech32 } from '@scure/base'

export class UsernameValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsernameValidationError'
  }
}

export class PubkeyValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PubkeyValidationError'
  }
}

/**
 * Validates and canonicalizes a username according to DNS label rules
 * @param username - The username to validate
 * @returns Object with display (original case) and canonical (lowercase) versions
 * @throws UsernameValidationError if validation fails
 */
export function validateUsername(username: string): { display: string; canonical: string } {
  // Trim whitespace
  const candidate = username.trim()

  // Reject empty
  if (!candidate || candidate.length === 0) {
    throw new UsernameValidationError('Username is required')
  }

  // Reject if length < 1 or > 63 (DNS label limit)
  if (candidate.length < 1 || candidate.length > 63) {
    throw new UsernameValidationError('Usernames must be 1–63 characters')
  }

  // Reject if contains anything outside [A-Za-z0-9-]
  const validPattern = /^[A-Za-z0-9-]+$/
  if (!validPattern.test(candidate)) {
    throw new UsernameValidationError('Usernames can only contain letters, numbers, and hyphens')
  }

  // Reject if starts or ends with hyphen
  if (candidate.startsWith('-') || candidate.endsWith('-')) {
    throw new UsernameValidationError("Usernames can't start or end with a hyphen")
  }

  // Canonicalize to lowercase
  const canonical = candidate.toLowerCase()

  return {
    display: candidate,
    canonical
  }
}

export class RelayValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayValidationError'
  }
}

export function validateRelays(relays: string[] | null): void {
  if (relays === null || relays === undefined) {
    return
  }

  if (!Array.isArray(relays)) {
    throw new RelayValidationError('Relays must be an array')
  }

  if (relays.length === 0) {
    return
  }

  if (relays.length > 50) {
    throw new RelayValidationError('Maximum 50 relays allowed')
  }

  for (const relay of relays) {
    if (typeof relay !== 'string') {
      throw new RelayValidationError('Relay must be a string')
    }

    if (relay.length > 200) {
      throw new RelayValidationError('Relay URL too long (max 200 characters)')
    }

    if (!relay.startsWith('wss://')) {
      throw new RelayValidationError('Relay must be a wss:// URL')
    }

    // Basic URL validation
    try {
      new URL(relay)
    } catch {
      throw new RelayValidationError('Invalid relay URL format')
    }
  }
}

/**
 * Converts bytes to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Convert 5-bit words to 8-bit bytes (for bech32 decoding)
 */
function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): Uint8Array | null {
  let acc = 0
  let bits = 0
  const result: number[] = []
  const maxv = (1 << toBits) - 1

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      return null
    }
    acc = (acc << fromBits) | value
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      result.push((acc >> bits) & maxv)
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv)
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null
  }

  return new Uint8Array(result)
}

/**
 * Validates and normalizes a pubkey to 64-character hex format
 * Accepts both hex (64 chars) and npub (bech32 encoded) formats
 * @param pubkey - The public key in hex or npub format
 * @returns The public key in 64-character hex format
 * @throws PubkeyValidationError if the format is invalid
 */
export function validateAndNormalizePubkey(pubkey: string): string {
  if (!pubkey || typeof pubkey !== 'string') {
    throw new PubkeyValidationError('Pubkey is required')
  }

  const trimmed = pubkey.trim()

  // Check if it's npub format (bech32)
  if (trimmed.startsWith('npub1')) {
    try {
      // Type assertion needed because TypeScript can't verify the string pattern at compile time
      const decoded = bech32.decode(trimmed as `${string}1${string}`, 1000)

      if (decoded.prefix !== 'npub') {
        throw new PubkeyValidationError('Invalid npub prefix')
      }

      // Convert from 5-bit words to 8-bit bytes
      const bytes = convertBits(decoded.words, 5, 8, false)

      if (!bytes || bytes.length !== 32) {
        throw new PubkeyValidationError('Invalid npub length (must decode to 32 bytes)')
      }

      return bytesToHex(bytes)
    } catch (error) {
      if (error instanceof PubkeyValidationError) {
        throw error
      }
      throw new PubkeyValidationError('Invalid npub format')
    }
  }

  // Check if it's hex format (64 characters)
  if (trimmed.length === 64 && /^[0-9a-f]+$/i.test(trimmed)) {
    return trimmed.toLowerCase()
  }

  throw new PubkeyValidationError('Pubkey must be 64-character hex or npub1... format')
}
