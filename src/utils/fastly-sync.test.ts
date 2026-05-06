import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { syncBatch, type SyncItem, type FastlyEnv } from './fastly-sync'

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
