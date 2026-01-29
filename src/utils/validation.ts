// ABOUTME: Username and pubkey validation utilities for format checking
// ABOUTME: Enforces IDNA 2008 rules for internationalized domain names (Unicode + ASCII)

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
 * Converts a Unicode domain label to its ASCII/Punycode equivalent using IDNA
 * @param label - The Unicode label to convert
 * @returns The ASCII-compatible encoding (punycode if needed)
 */
function toAsciiLabel(label: string): string {
  // Use URL API for IDNA conversion - it handles punycode encoding
  try {
    const url = new URL(`http://${label}.test`)
    // Extract just the first label (before .test)
    const hostname = url.hostname
    const asciiLabel = hostname.split('.')[0]
    return asciiLabel
  } catch {
    throw new UsernameValidationError('Username contains invalid characters for domain names')
  }
}

/**
 * Checks if a string contains only ASCII characters valid for domain labels
 */
function isAsciiLabel(str: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(str)
}

/**
 * Validates and canonicalizes a username according to IDNA 2008 rules
 * Supports both ASCII usernames and internationalized (Unicode) usernames
 * @param username - The username to validate (can be ASCII or Unicode)
 * @returns Object with display (original) and canonical (ASCII/punycode lowercase) versions
 * @throws UsernameValidationError if validation fails
 */
export function validateUsername(username: string): { display: string; canonical: string } {
  // Trim whitespace
  const candidate = username.trim()

  // Reject empty
  if (!candidate || candidate.length === 0) {
    throw new UsernameValidationError('Username is required')
  }

  // Basic length check on input (generous limit for Unicode)
  if (candidate.length > 63) {
    throw new UsernameValidationError('Usernames must be 1–63 characters')
  }

  // Reject if starts or ends with hyphen (applies to both Unicode and ASCII)
  if (candidate.startsWith('-') || candidate.endsWith('-')) {
    throw new UsernameValidationError("Usernames can't start or end with a hyphen")
  }

  // Reject invalid characters that are never allowed in domain names
  // This catches spaces, underscores, dots, and other punctuation early
  const invalidChars = /[\s_.@!#$%^&*()+=\[\]{}|\\:;"'<>,?/`~]/
  if (invalidChars.test(candidate)) {
    throw new UsernameValidationError('Usernames cannot contain spaces, underscores, dots, or special characters')
  }

  // Reject emojis and other symbols - they are not valid in IDN
  // Unicode emoji ranges: various blocks including symbols, pictographs, emoticons
  const emojiPattern = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1FA00}-\u{1FAFF}]/u
  if (emojiPattern.test(candidate)) {
    throw new UsernameValidationError('Usernames cannot contain emojis')
  }

  let canonical: string

  // Check if it's pure ASCII or contains Unicode
  if (isAsciiLabel(candidate)) {
    // Pure ASCII path - simple lowercase
    canonical = candidate.toLowerCase()
  } else {
    // Unicode path - convert to punycode via IDNA
    try {
      canonical = toAsciiLabel(candidate.toLowerCase())
    } catch (e) {
      if (e instanceof UsernameValidationError) {
        throw e
      }
      throw new UsernameValidationError('Username contains invalid characters for domain names')
    }

    // Verify the conversion produced valid output
    if (!canonical || canonical.length === 0) {
      throw new UsernameValidationError('Username contains invalid characters for domain names')
    }
  }

  // Validate canonical form length (DNS label limit is 63 octets)
  if (canonical.length > 63) {
    throw new UsernameValidationError('Username is too long when encoded for DNS (max 63 characters)')
  }

  // Validate canonical form is valid ASCII label
  if (!isAsciiLabel(canonical)) {
    throw new UsernameValidationError('Username contains invalid characters for domain names')
  }

  // IDNA rule: labels cannot have hyphens at positions 3 and 4 unless it's a valid ACE prefix (xn--)
  // This prevents confusion with punycode-encoded labels
  if (canonical.length >= 4 && canonical[2] === '-' && canonical[3] === '-') {
    if (!canonical.startsWith('xn--')) {
      throw new UsernameValidationError('Usernames cannot have hyphens at positions 3 and 4')
    }
  }

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
