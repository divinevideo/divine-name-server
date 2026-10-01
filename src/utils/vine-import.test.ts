import { describe, expect, it } from 'vitest'
import { deriveImportName, type ImportRow } from './vine-import'

const row = (overrides: Partial<ImportRow> = {}): ImportRow =>
  ({ vine_user_id: 42, username: 'plain_name', pubkey: 'a'.repeat(64), vanity_urls: null, ...overrides })

describe('deriveImportName', () => {
  it('keeps the casing the creator wrote, which the server shows as their display name', () => {
    expect(deriveImportName(row({ username: 'JaneDoe' }))).toBe('JaneDoe')
    expect(deriveImportName(row({ username: 'Élodie' }))).toBe('Elodie')
  })

  it('prefers the first vanity URL, as an array or as JSON text, and falls back to the username', () => {
    expect(deriveImportName(row({ vanity_urls: ['Vanity-One', 'second'] }))).toBe('Vanity-One')
    expect(deriveImportName(row({ vanity_urls: '["Vanity-One"]' }))).toBe('Vanity-One')
    expect(deriveImportName(row({ vanity_urls: 'not json' }))).toBe('plain-name')
    expect(deriveImportName(row({ vanity_urls: [7] }))).toBe('plain-name')
  })

  it('turns anything else into single hyphens, trims them, and limits the length', () => {
    expect(deriveImportName(row({ username: 'cool_dude' }))).toBe('cool-dude')
    expect(deriveImportName(row({ username: '--first..last--' }))).toBe('first-last')
    expect(deriveImportName(row({ username: 'a'.repeat(62) + '_b' }))).toBe('a'.repeat(62))
  })

  it('falls back to the archive id when nothing usable is left', () => {
    expect(deriveImportName(row({ username: '___' }))).toBe('vine-42')
    expect(deriveImportName(row({ username: null }))).toBe('vine-42')
  })
})
