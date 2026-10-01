import { describe, expect, it, vi } from 'vitest'
import { deriveImportName, importRows, type ImportRow } from './vine-import'

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

describe('importRows', () => {
  const rows = ['one', 'two', 'three', 'four'].map((username, index) => row({ vine_user_id: index, username }))

  it('imports the derived name for each row in order and counts each outcome', async () => {
    const outcomes = ['inserted', 'conflict', 'invalid', 'inserted'] as const
    let call = 0
    const importOne = vi.fn(async (_assignment: { name: string; pubkey: string }) => outcomes[call++])
    expect(await importRows(rows, importOne)).toEqual({ counts: { inserted: 2, conflicts: 1, invalid: 1 }, processed: 4 })
    expect(importOne.mock.calls.map(([assignment]) => assignment.name)).toEqual(['one', 'two', 'three', 'four'])
    expect(importOne.mock.calls[0][0].pubkey).toBe('a'.repeat(64))
  })

  // The caller must be able to report what was already imported: a re-run starts
  // from the first row again and counts those names as conflicts.
  it('stops at the first failure without throwing and returns the counts so far', async () => {
    const failure = new Error('Name import failed: HTTP 502')
    let call = 0
    const importOne = vi.fn(async (_assignment: { name: string; pubkey: string }) => {
      if (++call === 3) throw failure
      return 'inserted' as const
    })
    expect(await importRows(rows, importOne)).toEqual({ counts: { inserted: 2, conflicts: 0, invalid: 0 }, processed: 2, error: failure })
    expect(importOne).toHaveBeenCalledTimes(3)
  })

  it('handles an empty source', async () => {
    expect(await importRows([], vi.fn())).toEqual({ counts: { inserted: 0, conflicts: 0, invalid: 0 }, processed: 0 })
  })
})
