// ABOUTME: Username validation utilities for format checking
// ABOUTME: Enforces 3-20 char lowercase alphanumeric requirement

export class UsernameValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsernameValidationError'
  }
}

export function validateUsername(username: string): void {
  if (!username || username.length === 0) {
    throw new UsernameValidationError('Username is required')
  }

  if (username.length < 3 || username.length > 20) {
    throw new UsernameValidationError('Username must be 3-20 characters')
  }

  const validPattern = /^[a-z0-9]+$/
  if (!validPattern.test(username)) {
    throw new UsernameValidationError('Username must be lowercase alphanumeric')
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
