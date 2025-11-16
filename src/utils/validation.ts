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
