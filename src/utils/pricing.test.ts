// ABOUTME: Tests for tiered username pricing logic

import { describe, it, expect } from 'vitest'
import { getRegistrationPrice, getRenewalPrice, isPremiumName } from './pricing'

describe('getRegistrationPrice', () => {
  it('should charge 10000 sats for 1-2 char names', () => {
    expect(getRegistrationPrice('ab')).toBe(10000)
    expect(getRegistrationPrice('x')).toBe(10000)
  })

  it('should charge 5000 sats for 3 char names', () => {
    expect(getRegistrationPrice('joe')).toBe(5000)
    expect(getRegistrationPrice('bob')).toBe(5000)
  })

  it('should charge 2000 sats for 4-5 char names', () => {
    expect(getRegistrationPrice('john')).toBe(2000)
    expect(getRegistrationPrice('alice')).toBe(2000)
  })

  it('should charge 1000 sats for 6+ char names', () => {
    expect(getRegistrationPrice('charlie')).toBe(1000)
    expect(getRegistrationPrice('someverylongname')).toBe(1000)
  })

  it('should charge premium price for dictionary words regardless of length', () => {
    expect(getRegistrationPrice('music')).toBe(10000)
    expect(getRegistrationPrice('ai')).toBe(10000) // premium overrides 1-2 char
    expect(getRegistrationPrice('bitcoin')).toBe(10000)
  })

  it('should allow env var override', () => {
    const override = JSON.stringify({ '6+': 500, 'premium': 50000 })
    expect(getRegistrationPrice('charlie', override)).toBe(500)
    expect(getRegistrationPrice('music', override)).toBe(50000)
    // Non-overridden tiers use defaults
    expect(getRegistrationPrice('ab', override)).toBe(10000)
  })

  it('should fall back to defaults on invalid JSON', () => {
    expect(getRegistrationPrice('charlie', 'not-json')).toBe(1000)
  })
})

describe('getRenewalPrice', () => {
  it('should be higher than registration for all tiers', () => {
    expect(getRenewalPrice('ab')).toBeGreaterThan(getRegistrationPrice('ab'))
    expect(getRenewalPrice('joe')).toBeGreaterThan(getRegistrationPrice('joe'))
    expect(getRenewalPrice('john')).toBeGreaterThan(getRegistrationPrice('john'))
    expect(getRenewalPrice('charlie')).toBeGreaterThan(getRegistrationPrice('charlie'))
    expect(getRenewalPrice('music')).toBeGreaterThan(getRegistrationPrice('music'))
  })
})

describe('isPremiumName', () => {
  it('should identify premium names', () => {
    expect(isPremiumName('music')).toBe(true)
    expect(isPremiumName('bitcoin')).toBe(true)
    expect(isPremiumName('vine')).toBe(true)
  })

  it('should not flag normal names', () => {
    expect(isPremiumName('randomuser123')).toBe(false)
    expect(isPremiumName('johndoe')).toBe(false)
  })
})
