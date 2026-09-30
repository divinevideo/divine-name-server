import { afterEach, describe, expect, it, vi } from 'vitest'
import { importName } from './import-client'
afterEach(() => vi.unstubAllGlobals())
describe('importer API boundary', () => {
  it('writes only to the ownership-checked API and returns conflicts without a KV write', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 201 })).mockResolvedValueOnce(new Response('', { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const assignment = { name: 'alice', pubkey: 'a'.repeat(64) }
    expect(await importName('https://names.example.test', 'synthetic-token', assignment)).toBe('inserted')
    expect(await importName('https://names.example.test', 'synthetic-token', assignment)).toBe('conflict')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[0][0])).toBe('https://names.example.test/api/internal/username/import')
    expect(fetcher.mock.calls[0][1].redirect).toBe('error')
  })
  it('stops on failed or ambiguous responses and never sends credentials over remote HTTP', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(importName('http://names.example.test', 'test', { name: 'alice', pubkey: 'a'.repeat(64) })).rejects.toThrow('HTTPS')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(importName('https://names.example.test', 'test', { name: 'alice', pubkey: 'a'.repeat(64) })).rejects.toThrow('HTTP 500')
  })
  it('counts a rejected source row without treating it as an insertion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })))
    expect(await importName('https://names.example.test', 'test', { name: 'alice', pubkey: 'bad' })).toBe('invalid')
  })
})
