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
}

const FASTLY_API_BASE = 'https://api.fastly.com'

/**
 * Sync a username to Fastly KV Store
 * Called when a username is claimed or updated
 */
export async function syncUsernameToFastly(
  env: FastlyEnv,
  username: string,
  data: UsernameKVData
): Promise<{ success: boolean; error?: string }> {
  if (!env.FASTLY_API_TOKEN || !env.FASTLY_STORE_ID) {
    console.log('Fastly sync skipped: missing FASTLY_API_TOKEN or FASTLY_STORE_ID')
    return { success: true } // Don't fail if Fastly is not configured
  }

  const url = `${FASTLY_API_BASE}/resources/stores/kv/${env.FASTLY_STORE_ID}/keys/${encodeURIComponent(username)}`

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Fastly-Key': env.FASTLY_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`Fastly sync failed for ${username}: ${response.status} ${errorText}`)
      return { success: false, error: `Fastly API error: ${response.status}` }
    }

    console.log(`Fastly sync success: ${username} -> ${data.status}`)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`Fastly sync error for ${username}: ${message}`)
    return { success: false, error: message }
  }
}

/**
 * Delete a username from Fastly KV Store
 * Called when a username is burned or permanently removed
 */
export async function deleteUsernameFromFastly(
  env: FastlyEnv,
  username: string
): Promise<{ success: boolean; error?: string }> {
  if (!env.FASTLY_API_TOKEN || !env.FASTLY_STORE_ID) {
    console.log('Fastly delete skipped: missing FASTLY_API_TOKEN or FASTLY_STORE_ID')
    return { success: true }
  }

  const url = `${FASTLY_API_BASE}/resources/stores/kv/${env.FASTLY_STORE_ID}/keys/${encodeURIComponent(username)}`

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

/**
 * Bulk sync multiple usernames to Fastly
 * Used for initial sync or recovery
 */
export async function bulkSyncToFastly(
  env: FastlyEnv,
  usernames: Array<{ username: string; data: UsernameKVData }>
): Promise<{ success: number; failed: number; errors: string[] }> {
  const results = { success: 0, failed: 0, errors: [] as string[] }

  for (const { username, data } of usernames) {
    const result = await syncUsernameToFastly(env, username, data)
    if (result.success) {
      results.success++
    } else {
      results.failed++
      results.errors.push(`${username}: ${result.error}`)
    }
  }

  return results
}
