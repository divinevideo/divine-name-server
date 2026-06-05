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

export function normalizeUsernameKVData(data: UsernameKVData): UsernameKVData {
  return {
    pubkey: data.pubkey,
    relays: [...data.relays].sort(),
    status: data.status,
    atproto_did: data.atproto_did ?? null,
    atproto_state: data.atproto_state ?? null,
  }
}

export function usernameKVDataMatches(actual: UsernameKVData, expected: UsernameKVData): boolean {
  const normalizedActual = normalizeUsernameKVData(actual)
  const normalizedExpected = normalizeUsernameKVData(expected)

  return normalizedActual.pubkey === normalizedExpected.pubkey
    && normalizedActual.status === normalizedExpected.status
    && normalizedActual.atproto_did === normalizedExpected.atproto_did
    && normalizedActual.atproto_state === normalizedExpected.atproto_state
    && JSON.stringify(normalizedActual.relays) === JSON.stringify(normalizedExpected.relays)
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
      if (response.status < 500 && response.status !== 429) {
        return { success: false, error: `${lastError} ${errorText}`.trim() }
      }
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
    const error = 'Fastly sync configuration is missing'
    console.error('Fastly delete failed: missing FASTLY_API_TOKEN or FASTLY_STORE_ID')
    return { success: false, error }
  }

  // Key format must match compute-js expectations: user:{username}
  const kvKey = `user:${username}`
  const url = `${FASTLY_API_BASE}/resources/stores/kv/${env.FASTLY_STORE_ID}/keys/${encodeURIComponent(kvKey)}`

  let lastError = ''
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Fastly-Key': env.FASTLY_API_TOKEN,
        },
      })

      // 404 is fine - key might not exist
      if (response.ok || response.status === 404) {
        if (attempt > 0) console.log(`Fastly delete success for ${username} on attempt ${attempt + 1}`)
        else console.log(`Fastly delete success: ${username}`)
        return { success: true }
      }

      lastError = `Fastly API error: ${response.status}`
      const errorText = await response.text()
      console.error(`Fastly delete attempt ${attempt + 1}/${MAX_RETRIES} failed for ${username}: ${response.status} ${errorText}`)
      if (response.status < 500 && response.status !== 429) {
        return { success: false, error: `${lastError} ${errorText}`.trim() }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error'
      console.error(`Fastly delete attempt ${attempt + 1}/${MAX_RETRIES} error for ${username}: ${lastError}`)
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt))
    }
  }

  console.error(`Fastly delete FAILED for ${username} after ${MAX_RETRIES} attempts`)
  return { success: false, error: lastError }
}

export async function readUsernameFromFastly(
  env: FastlyEnv,
  username: string
): Promise<{ success: boolean; data?: UsernameKVData; error?: string }> {
  if (!env.FASTLY_API_TOKEN || !env.FASTLY_STORE_ID) {
    return { success: false, error: 'Fastly sync configuration is missing' }
  }

  const kvKey = `user:${username}`
  const url = `${FASTLY_API_BASE}/resources/stores/kv/${env.FASTLY_STORE_ID}/keys/${encodeURIComponent(kvKey)}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Fastly-Key': env.FASTLY_API_TOKEN,
      },
    })

    if (response.status === 404) {
      return { success: true, data: undefined }
    }

    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, error: `Fastly API error: ${response.status} ${errorText}` }
    }

    const data = await response.json() as UsernameKVData
    return { success: true, data }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

export async function syncAndVerifyUsername(
  env: FastlyEnv,
  username: string,
  data: UsernameKVData
): Promise<{ success: boolean; verified: boolean; error?: string }> {
  const syncResult = await syncUsernameToFastly(env, username, data)
  if (!syncResult.success) {
    return { success: false, verified: false, error: syncResult.error }
  }

  const verifyResult = await readUsernameFromFastly(env, username)
  if (!verifyResult.success) {
    const error = `Fastly verify read failed: ${verifyResult.error}`
    console.warn(`${error} for ${username}`)
    return { success: true, verified: false, error }
  }

  if (!verifyResult.data) {
    const error = 'Fastly verify failed: key missing after successful write'
    console.error(`${error} for ${username}`)
    return { success: true, verified: false, error }
  }

  if (!usernameKVDataMatches(verifyResult.data, data)) {
    const expected = JSON.stringify(normalizeUsernameKVData(data))
    const actual = JSON.stringify(normalizeUsernameKVData(verifyResult.data))
    const error = `Fastly verify failed: wrote ${expected} but read ${actual}`
    console.error(`${error} for ${username}`)
    return { success: true, verified: false, error }
  }

  return { success: true, verified: true }
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
  successes: Array<{ username: string; action: 'sync' | 'delete' }>
  failures: Array<{ username: string; action: 'sync' | 'delete'; error: string }>
}

export async function syncBatch(
  env: FastlyEnv,
  items: SyncItem[],
  options?: { concurrency?: number }
): Promise<SyncBatchResult> {
  const concurrency = options?.concurrency ?? 10
  const result: SyncBatchResult = { synced: 0, deleted: 0, failed: 0, errors: [], successes: [], failures: [] }

  if (items.length === 0) return result

  const queue = [...items]
  const inflight = new Set<Promise<void>>()

  const processItem = async (item: SyncItem): Promise<void> => {
    if (item.action === 'sync' && item.data) {
      const res = await syncUsernameToFastly(env, item.username, item.data)
      if (res.success) {
        result.synced++
        result.successes.push({ username: item.username, action: item.action })
      }
      else {
        result.failed++
        const error = res.error || 'Unknown sync error'
        result.errors.push(`${item.username}: ${error}`)
        result.failures.push({ username: item.username, action: item.action, error })
      }
    } else if (item.action === 'sync' && !item.data) {
      result.failed++
      const error = 'sync action missing data'
      result.errors.push(`${item.username}: ${error}`)
      result.failures.push({ username: item.username, action: item.action, error })
    } else if (item.action === 'delete') {
      const res = await deleteUsernameFromFastly(env, item.username)
      if (res.success) {
        result.deleted++
        result.successes.push({ username: item.username, action: item.action })
      }
      else {
        result.failed++
        const error = res.error || 'Unknown delete error'
        result.errors.push(`${item.username}: ${error}`)
        result.failures.push({ username: item.username, action: item.action, error })
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
