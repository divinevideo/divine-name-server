// ABOUTME: The prepared preset enforces through Clef without adding a third mode.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JUDGMENT_MODEL } from './judgment'

describe('prepared judgment configuration', () => {
  it('checks in the binding and string starting threshold', () => {
    const config = readFileSync(fileURLToPath(new URL('../../wrangler.toml', import.meta.url)), 'utf8')
    expect(config.match(/^JUDGMENT_BLOCK_MIN\s*=\s*"([^"]+)"/m)?.[1]).toBe('0.60')
    expect(config.match(/^\[ai\]\s*\nbinding\s*=\s*"([^"]+)"/m)?.[1]).toBe('AI')
    expect(JUDGMENT_MODEL).toBe('@cf/cloudflare/clef')
    expect(config.match(/^JUDGMENT_(?:MODE|OBSERVE_ONLY)\s*=/m)).toBeNull()
  })
})
