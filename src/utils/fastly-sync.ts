// ABOUTME: Fastly KV Store sync utility for username data
// ABOUTME: Syncs username-pubkey mappings to Fastly edge for NIP-05 and profile routing

export interface FastlyEnv {
  FASTLY_API_TOKEN?: string
  FASTLY_STORE_ID?: string
}

export interface UsernameKVData {
  pubkey: string
  relays: string[]
  status: 'active' | 'revoked' | 'reserved' | 'burned'
  atproto_did?: string | null
  atproto_state?: 'pending' | 'ready' | 'failed' | 'disabled' | null
}

export function parseRelayHints(relays: string | null | undefined): string[] {
  if (!relays) return []
  try {
    const parsed = JSON.parse(relays)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

const FASTLY_API_BASE = 'https://api.fastly.com'
const MAX_RETRIES = 3
const RETRY_BASE_MS = 200

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Sync a username to Fastly KV Store with retry
 * Called when a username is claimed or updated
 * Key format: user:{username} to match compute-js edge worker expectations
 * Retries up to 3 times with exponential backoff (200ms, 400ms, 800ms)
 */
export async function syncUsernameToFastly(
  env: FastlyEnv,
  username: string,
  data: UsernameKVData
): Promise<{ success: boolean; error?: string }> {
  if (!env.FASTLY_API_TOKEN || !env.FASTLY_STORE_ID) {
    const error = 'Fastly sync configuration is missing'
    console.error(`${error}: FASTLY_API_TOKEN or FASTLY_STORE_ID is unset`)
    return { success: false, error }
  }

  // Key format must match compute-js expectations: user:{username}
  const kvKey = `user:${username}`
  const url = `${FASTLY_API_BASE}/resources/stores/kv/${env.FASTLY_STORE_ID}/keys/${encodeURIComponent(kvKey)}`

  let lastError = ''
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Fastly-Key': env.FASTLY_API_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })

      if (response.ok) {
        if (attempt > 0) console.log(`Fastly sync success for ${username} on attempt ${attempt + 1}`)
        else console.log(`Fastly sync success: ${username} -> ${data.status}`)
        return { success: true }
      }

      lastError = `Fastly API error: ${response.status}`
      const errorText = await response.text()
      console.error(`Fastly sync attempt ${attempt + 1}/${MAX_RETRIES} failed for ${username}: ${response.status} ${errorText}`)
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error'
      console.error(`Fastly sync attempt ${attempt + 1}/${MAX_RETRIES} error for ${username}: ${lastError}`)
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt))
    }
  }

  console.error(`Fastly sync FAILED for ${username} after ${MAX_RETRIES} attempts`)
  return { success: false, error: lastError }
}

/**
 * Delete a username from Fastly KV Store
 * Called when a username is burned or permanently removed
 * Key format: user:{username} to match compute-js edge worker expectations
 */
export async function deleteUsernameFromFastly(
  env: FastlyEnv,
  username: string
): Promise<{ success: boolean; error?: string }> {
  if (!env.FASTLY_API_TOKEN || !env.FASTLY_STORE_ID) {
    console.log('Fastly delete skipped: missing FASTLY_API_TOKEN or FASTLY_STORE_ID')
    return { success: true }
  }

  // Key format must match compute-js expectations: user:{username}
  const kvKey = `user:${username}`
  const url = `${FASTLY_API_BASE}/resources/stores/kv/${env.FASTLY_STORE_ID}/keys/${encodeURIComponent(kvKey)}`

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Fastly-Key': env.FASTLY_API_TOKEN,
      },
    })

    // 404 is fine - key might not exist
    if (!response.ok && response.status !== 404) {
      const errorText = await response.text()
      console.error(`Fastly delete failed for ${username}: ${response.status} ${errorText}`)
      return { success: false, error: `Fastly API error: ${response.status}` }
    }

    console.log(`Fastly delete success: ${username}`)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`Fastly delete error for ${username}: ${message}`)
    return { success: false, error: message }
  }
}

export interface SyncItem {
  username: string
  action: 'sync' | 'delete'
  data?: UsernameKVData
}

export interface SyncBatchResult {
  synced: number
  deleted: number
  failed: number
  errors: string[]
}

export async function syncBatch(
  env: FastlyEnv,
  items: SyncItem[],
  options?: { concurrency?: number }
): Promise<SyncBatchResult> {
  const concurrency = options?.concurrency ?? 10
  const result: SyncBatchResult = { synced: 0, deleted: 0, failed: 0, errors: [] }

  if (items.length === 0) return result

  const queue = [...items]
  const inflight = new Set<Promise<void>>()

  const processItem = async (item: SyncItem): Promise<void> => {
    if (item.action === 'sync' && item.data) {
      const res = await syncUsernameToFastly(env, item.username, item.data)
      if (res.success) result.synced++
      else {
        result.failed++
        result.errors.push(`${item.username}: ${res.error}`)
      }
    } else if (item.action === 'sync' && !item.data) {
      result.failed++
      result.errors.push(`${item.username}: sync action missing data`)
    } else if (item.action === 'delete') {
      const res = await deleteUsernameFromFastly(env, item.username)
      if (res.success) result.deleted++
      else {
        result.failed++
        result.errors.push(`${item.username}: ${res.error}`)
      }
    }
  }

  while (queue.length > 0 || inflight.size > 0) {
    while (queue.length > 0 && inflight.size < concurrency) {
      const item = queue.shift()!
      const promise = processItem(item).then(() => {
        inflight.delete(promise)
      })
      inflight.add(promise)
    }
    if (inflight.size > 0) {
      await Promise.race(inflight)
    }
  }

  return result
}
