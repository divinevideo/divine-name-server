// ABOUTME: Tiered username pricing based on name length and premium status
// ABOUTME: Returns registration price in sats; configurable via env vars

/**
 * Default pricing tiers (in sats).
 * Low registration fee to reduce barrier, higher renewal (enforced later).
 *
 * Override with env var NAME_PRICE_JSON, e.g.:
 * {"1-2":10000,"3":5000,"4-5":2000,"6+":1000,"premium":10000}
 */
const DEFAULT_PRICES: Record<string, number> = {
  '1-2': 10000,   // ~$10 — very short, high value
  '3': 5000,      // ~$5
  '4-5': 2000,    // ~$2
  '6+': 1000,     // ~$1 — standard names
  'premium': 10000, // ~$10 — dictionary words / curated list
}

/**
 * Curated premium names — dictionary words, common terms.
 * These get premium pricing regardless of length.
 */
const PREMIUM_NAMES: Set<string> = new Set([
  // Music / creative
  'music', 'dance', 'art', 'video', 'film', 'photo', 'sound', 'beat',
  'remix', 'loop', 'live', 'sing', 'play', 'band', 'song', 'audio',
  // Social
  'love', 'follow', 'share', 'like', 'viral', 'trend', 'famous', 'star',
  'fan', 'crew', 'squad', 'vibe', 'mood', 'real', 'legend',
  // Tech / crypto
  'bitcoin', 'crypto', 'nostr', 'relay', 'lightning', 'cashu', 'zap',
  'code', 'hack', 'dev', 'app', 'web', 'ai', 'bot',
  // Vine-specific
  'vine', 'divine', 'loop', 'creator', 'comedy', 'funny', 'lol',
  // Generic high-value
  'admin', 'support', 'help', 'official', 'news', 'shop', 'store',
  'money', 'cash', 'pay', 'gold', 'king', 'queen', 'boss', 'god',
])

/**
 * Get the registration price in sats for a given canonical username.
 *
 * @param nameCanonical - lowercase canonical form of the username
 * @param envPriceJson - optional NAME_PRICE_JSON env var override
 * @returns price in sats
 */
export function getRegistrationPrice(nameCanonical: string, envPriceJson?: string): number {
  let prices = DEFAULT_PRICES

  // Allow env var override for pricing
  if (envPriceJson) {
    try {
      prices = { ...DEFAULT_PRICES, ...JSON.parse(envPriceJson) }
    } catch {
      // Fall back to defaults on parse error
    }
  }

  // Check premium list first
  if (PREMIUM_NAMES.has(nameCanonical)) {
    return prices['premium'] ?? DEFAULT_PRICES['premium']
  }

  const len = nameCanonical.length

  if (len <= 2) return prices['1-2'] ?? DEFAULT_PRICES['1-2']
  if (len === 3) return prices['3'] ?? DEFAULT_PRICES['3']
  if (len <= 5) return prices['4-5'] ?? DEFAULT_PRICES['4-5']
  return prices['6+'] ?? DEFAULT_PRICES['6+']
}

/**
 * Get the annual renewal price in sats for a given canonical username.
 * Renewal is roughly 2-5x registration to discourage squatting.
 */
export function getRenewalPrice(nameCanonical: string, envPriceJson?: string): number {
  let prices: Record<string, number> = {
    '1-2': 50000,
    '3': 20000,
    '4-5': 5000,
    '6+': 2000,
    'premium': 100000,
  }

  // Future: allow RENEWAL_PRICE_JSON env var override
  
  if (PREMIUM_NAMES.has(nameCanonical)) {
    return prices['premium']
  }

  const len = nameCanonical.length
  if (len <= 2) return prices['1-2']
  if (len === 3) return prices['3']
  if (len <= 5) return prices['4-5']
  return prices['6+']
}

/**
 * Check if a name is on the premium list.
 */
export function isPremiumName(nameCanonical: string): boolean {
  return PREMIUM_NAMES.has(nameCanonical)
}
