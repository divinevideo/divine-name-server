// ABOUTME: Cashu ecash token parsing and validation utilities
// ABOUTME: Parses cashuA tokens and validates mint allowlists and proof amounts

export interface CashuProof {
  amount: number
  id: string
  secret: string
  C: string
}

export interface CashuTokenEntry {
  mint: string
  proofs: CashuProof[]
}

export interface ParsedCashuToken {
  tokens: CashuTokenEntry[]
  unit?: string
}

export class CashuValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CashuValidationError'
  }
}

// Parse a cashuA token (cashuA prefix + base64url-encoded JSON)
export function parseCashuToken(tokenStr: string): ParsedCashuToken {
  if (!tokenStr.startsWith('cashuA')) {
    throw new CashuValidationError('Invalid Cashu token: must start with "cashuA"')
  }

  const base64url = tokenStr.slice(6) // Remove "cashuA" prefix

  let decoded: string
  try {
    // Convert base64url to standard base64, then decode
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
    // Pad to a multiple of 4
    while (base64.length % 4 !== 0) {
      base64 += '='
    }
    decoded = atob(base64)
  } catch {
    throw new CashuValidationError('Invalid Cashu token: base64 decode failed')
  }

  let json: any
  try {
    json = JSON.parse(decoded)
  } catch {
    throw new CashuValidationError('Invalid Cashu token: JSON parse failed')
  }

  if (!Array.isArray(json.token) || json.token.length === 0) {
    throw new CashuValidationError('Invalid Cashu token: missing token array')
  }

  for (const entry of json.token) {
    if (typeof entry.mint !== 'string' || entry.mint.length === 0) {
      throw new CashuValidationError('Invalid Cashu token: missing mint URL')
    }
    if (!Array.isArray(entry.proofs) || entry.proofs.length === 0) {
      throw new CashuValidationError('Invalid Cashu token: missing proofs array')
    }
    for (const proof of entry.proofs) {
      if (typeof proof.amount !== 'number' || proof.amount <= 0) {
        throw new CashuValidationError('Invalid Cashu token: proof has invalid amount')
      }
      if (typeof proof.secret !== 'string' || proof.secret.length === 0) {
        throw new CashuValidationError('Invalid Cashu token: proof has missing secret')
      }
      if (typeof proof.C !== 'string' || proof.C.length === 0) {
        throw new CashuValidationError('Invalid Cashu token: proof has missing C value')
      }
    }
  }

  return {
    tokens: json.token as CashuTokenEntry[],
    unit: json.unit
  }
}

// Check that all token mint URLs are in the allowed mints list
export function validateMintAllowlist(tokens: CashuTokenEntry[], allowedMints: string[]): void {
  if (allowedMints.length === 0) {
    throw new CashuValidationError('No allowed mints configured')
  }
  for (const entry of tokens) {
    // Normalize by stripping trailing slashes before comparing
    const mintUrl = entry.mint.replace(/\/$/, '')
    const isAllowed = allowedMints.some(allowed => allowed.replace(/\/$/, '') === mintUrl)
    if (!isAllowed) {
      throw new CashuValidationError(`Mint ${entry.mint} is not in the allowed mints list`)
    }
  }
}

// Sum all proof amounts across all token entries
export function sumProofAmounts(tokens: CashuTokenEntry[]): number {
  return tokens.reduce((total, entry) => {
    return total + entry.proofs.reduce((subtotal, proof) => subtotal + proof.amount, 0)
  }, 0)
}

// Extract all proof secrets from a parsed token
export function getProofSecrets(tokens: CashuTokenEntry[]): string[] {
  return tokens.flatMap(entry => entry.proofs.map(proof => proof.secret))
}

// Compute SHA-256 hash of the raw token string for storage/tracking
export async function hashCashuToken(tokenStr: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(tokenStr)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}
