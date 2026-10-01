import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeImportFailure, ImportServiceError, ImportUsageError, importName } from './import-client'
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
  it('gives every request a deadline so a hung connection cannot stall a long run', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 201 }))
    vi.stubGlobal('fetch', fetcher)
    await importName('https://names.example.test', 'test', { name: 'alice', pubkey: 'a'.repeat(64) })
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
  it('reports an unreachable server with fixed text instead of the transport error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:443')))
    const failure = await importName('https://names.example.test', 'test', { name: 'alice', pubkey: 'a'.repeat(64) }).catch(error => error)
    expect(failure).toBeInstanceOf(ImportServiceError)
    expect(failure.message).toBe('Name import failed: no response from the name server')
  })
  it('flags a malformed server URL as a usage mistake', async () => {
    const failure = await importName('not a url', 'test', { name: 'alice', pubkey: 'a'.repeat(64) }).catch(error => error)
    expect(failure).toBeInstanceOf(ImportUsageError)
  })
})

describe('describeImportFailure', () => {
  it('prints the importer\'s own fixed messages', () => {
    expect(describeImportFailure(new ImportUsageError('Choose apply or dry-run'))).toBe('Choose apply or dry-run')
    expect(describeImportFailure(new ImportServiceError('Name import failed: HTTP 502'))).toBe('Name import failed: HTTP 502')
  })
  it('never prints driver or provider text, which can carry source data or credentials', () => {
    const message = describeImportFailure(new Error('password authentication failed for user "importer" on db.example.test'))
    expect(message).toBe('Import failed; check inputs and service availability before retrying')
    expect(describeImportFailure('not an error')).toBe(message)
  })
})
