// ABOUTME: Read-only, paginated comparisons of KV keys and authoritative D1 rows.
import { getUsernameByName, getActiveUsernamesPaginated } from '../db/queries'
import { readUsernameFromFastly, parseRelayHints, usernameKVDataMatches, type FastlyEnv } from './fastly-sync'

type DriftEnv = FastlyEnv & { DB: D1Database }

export async function compareFastlyName(env: DriftEnv, name: string) {
  const row = await getUsernameByName(env.DB, name)
  const actual = await readUsernameFromFastly(env, name)
  if (!actual.success) throw new Error('Fastly comparison read failed')
  if (!row) return actual.data ? { name, reason: 'no-d1-row' } : null
  if (row.status !== 'active' || !row.pubkey) return actual.data ? { name, reason: 'inactive-d1-row' } : null
  if (!actual.data) return { name, reason: 'missing-kv-key' }
  const expected = {
    pubkey: row.pubkey, relays: parseRelayHints(row.relays), status: 'active' as const,
    atproto_did: row.atproto_did, atproto_state: row.atproto_state,
  }
  try {
    if (usernameKVDataMatches(actual.data, expected)) return null
  } catch {
    return { name, reason: 'invalid-kv-data' }
  }
  return { name, reason: actual.data.pubkey !== row.pubkey ? 'pubkey-mismatch' : 'metadata-mismatch' }
}

export async function compareFastlyPage(env: DriftEnv, source: 'kv' | 'd1', cursor: string | null, limit: number) {
  let names: string[]
  let nextCursor: string | null
  if (source === 'd1') {
    const rows = await getActiveUsernamesPaginated(env.DB, cursor === null ? null : Number(cursor), limit)
    names = rows.map(row => row.username_canonical || row.name)
    nextCursor = rows.length === limit ? String(rows[rows.length - 1].id) : null
  } else {
    if (!env.FASTLY_API_TOKEN || !env.FASTLY_STORE_ID) throw new Error('Fastly configuration is missing')
    const url = new URL(`https://api.fastly.com/resources/stores/kv/${env.FASTLY_STORE_ID}/keys`)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('consistency', 'strong')
    if (cursor) url.searchParams.set('cursor', cursor)
    // Fastly's REST prefix parameter cannot include ':'. Filter the bounded
    // all-key page locally so user: keys and orphaned names are both covered.
    const response = await fetch(url, { headers: { 'Fastly-Key': env.FASTLY_API_TOKEN } })
    if (!response.ok) throw new Error('Fastly key listing failed')
    const page = await response.json() as { data: string[]; meta?: { next_cursor?: string } }
    if (!Array.isArray(page.data) || !page.data.every(key => typeof key === 'string') ||
        (page.meta?.next_cursor !== undefined && typeof page.meta.next_cursor !== 'string')) {
      throw new Error('Invalid Fastly key page')
    }
    names = page.data.filter(key => key.startsWith('user:')).map(key => key.slice(5))
    nextCursor = page.meta?.next_cursor || null
  }
  const differences = []
  for (const name of names) {
    const difference = await compareFastlyName(env, name)
    if (difference) differences.push(difference)
  }
  return { checked: names.length, differences, cursor: nextCursor }
}
