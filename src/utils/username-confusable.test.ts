import { describe, it, expect } from 'vitest'
import { findUsernameConfusableCollision, toUsernameSkeleton, type UsernameConfusableCandidate } from './username-confusable'

describe('username confusable detection', () => {
  it('generates the same skeleton for cross-script lookalikes', () => {
    const ascii = toUsernameSkeleton('matt')
    const mixedScript = toUsernameSkeleton('mаtt') // Cyrillic "а"
    expect(ascii).toBe(mixedScript)
  })

  it('finds a collision against active usernames', () => {
    const candidates: UsernameConfusableCandidate[] = [{
      name: 'matt',
      username_display: 'matt',
      username_canonical: 'matt',
      status: 'active',
      reservation_expires_at: null
    }]

    const collision = findUsernameConfusableCollision('mаtt', 'xn--mtt-5cd', candidates)
    expect(collision).not.toBeNull()
    expect(collision?.candidateCanonical).toBe('matt')
  })

  it('ignores collisions against the same canonical username', () => {
    const candidates: UsernameConfusableCandidate[] = [{
      name: 'matt',
      username_display: 'matt',
      username_canonical: 'matt',
      status: 'active',
      reservation_expires_at: null
    }]

    const collision = findUsernameConfusableCollision('matt', 'matt', candidates)
    expect(collision).toBeNull()
  })

  it('ignores revoked usernames', () => {
    const candidates: UsernameConfusableCandidate[] = [{
      name: 'matt',
      username_display: 'matt',
      username_canonical: 'matt',
      status: 'revoked',
      reservation_expires_at: null
    }]

    const collision = findUsernameConfusableCollision('mаtt', 'xn--mtt-5cd', candidates)
    expect(collision).toBeNull()
  })

  it('ignores expired pending-confirmation usernames', () => {
    const now = Math.floor(Date.now() / 1000)
    const candidates: UsernameConfusableCandidate[] = [{
      name: 'matt',
      username_display: 'matt',
      username_canonical: 'matt',
      status: 'pending-confirmation',
      reservation_expires_at: now - 60
    }]

    const collision = findUsernameConfusableCollision('mаtt', 'xn--mtt-5cd', candidates, now)
    expect(collision).toBeNull()
  })
})
