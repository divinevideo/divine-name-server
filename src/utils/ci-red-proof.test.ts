// ABOUTME: Temporary. Proves the new CI check can actually fail.
// ABOUTME: Removed in the next commit; see the PR for both run links.

import { describe, it, expect } from 'vitest'

describe('CI red proof', () => {
  it('fails on purpose so we can see the check go red', () => {
    expect('red').toBe('green')
  })
})
