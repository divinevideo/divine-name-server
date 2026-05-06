import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { syncBatch, readUsernameFromFastly, syncAndVerifyUsername, type SyncItem, type FastlyEnv } from './fastly-sync'

const env: FastlyEnv = {
  FASTLY_API_TOKEN: 'test-token',
  FASTLY_STORE_ID: 'test-store-id',
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('syncBatch', () => {
  it('should sync active users and delete revoked users', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' })

    const items: SyncItem[] = [
      { username: 'alice', action: 'sync', data: { pubkey: 'abc123', relays: [], status: 'active' } },
      { username: 'bob', action: 'delete' },
    ]

    const result = await syncBatch(env, items)

    expect(result.synced).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('should handle partial failures without aborting', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('user%3Afailing')) {
        return { ok: false, status: 500, text: async () => 'server error' }
      }
      return { ok: true, status: 200, text: async () => '' }
    })

    const items: SyncItem[] = [
      { username: 'failing', action: 'sync', data: { pubkey: 'aaa', relays: [], status: 'active' } },
      { username: 'passing', action: 'sync', data: { pubkey: 'bbb', relays: [], status: 'active' } },
    ]

    const result = await syncBatch(env, items)

    expect(result.synced).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('failing')
  })

  it('should respect concurrency limit', async () => {
    let concurrent = 0
    let maxConcurrent = 0

    mockFetch.mockImplementation(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 10))
      concurrent--
      return { ok: true, status: 200, text: async () => '' }
    })

    const items: SyncItem[] = Array.from({ length: 20 }, (_, i) => ({
      username: `user${i}`,
      action: 'sync' as const,
      data: { pubkey: `pk${i}`, relays: [], status: 'active' as const },
    }))

    await syncBatch(env, items, { concurrency: 3 })

    expect(maxConcurrent).toBeLessThanOrEqual(3)
    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('should return zeros for empty items array', async () => {
    const result = await syncBatch(env, [])

    expect(result.synced).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.failed).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('should skip sync when Fastly config is missing', async () => {
    const result = await syncBatch({ FASTLY_API_TOKEN: undefined, FASTLY_STORE_ID: undefined }, [
      { username: 'alice', action: 'sync', data: { pubkey: 'abc', relays: [], status: 'active' } },
    ])

    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain('alice')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('readUsernameFromFastly', () => {
  it('should return data for existing key', async () => {
    const kvData = { pubkey: 'abc123', relays: [], status: 'active' }
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => kvData,
    })

    const result = await readUsernameFromFastly(env, 'alice')

    expect(result.success).toBe(true)
    expect(result.data).toEqual(kvData)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('user%3Aalice'),
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('should return undefined data for 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' })

    const result = await readUsernameFromFastly(env, 'nonexistent')

    expect(result.success).toBe(true)
    expect(result.data).toBeUndefined()
  })

  it('should return error for non-404 failures', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' })

    const result = await readUsernameFromFastly(env, 'alice')

    expect(result.success).toBe(false)
    expect(result.error).toContain('500')
  })

  it('should return error when config is missing', async () => {
    const result = await readUsernameFromFastly({}, 'alice')

    expect(result.success).toBe(false)
    expect(result.error).toContain('missing')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('syncAndVerifyUsername', () => {
  const data = { pubkey: 'abc123', relays: [] as string[], status: 'active' as const }

  it('should return verified:true when read-back matches', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => data })

    const result = await syncAndVerifyUsername(env, 'alice', data)

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('should return verified:false when read-back has mismatch', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...data, pubkey: 'different' }) })

    const result = await syncAndVerifyUsername(env, 'alice', data)

    expect(result.success).toBe(true)
    expect(result.verified).toBe(false)
  })

  it('should return verified:false when key missing after write', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' })

    const result = await syncAndVerifyUsername(env, 'alice', data)

    expect(result.success).toBe(true)
    expect(result.verified).toBe(false)
  })

  it('should return success:false when sync itself fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'error' })

    const result = await syncAndVerifyUsername(env, 'alice', data)

    expect(result.success).toBe(false)
    expect(result.verified).toBe(false)
  })
})
