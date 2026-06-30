import type {
  SearchResult,
  SearchSort,
  UsernameLookupResponse,
  ReserveResponse,
  AssignResponse,
  RevokeResponse,
  ReservedWord,
  BulkReserveResponse,
  ApiResponse,
  TagDetail,
  FastlySyncPageResponse,
  Nip05StatusResponse,
  ResyncResponse,
  UsernameStatsResponse
} from '../types'

const API_BASE = '/api/admin'

// For endpoints whose callers render `result.error` directly, a non-2xx
// response still carries a useful JSON body (e.g. validation messages,
// `requiresOverride`). Return that parsed body instead of throwing on
// `response.statusText`, which is an empty string over HTTP/2 (no reason
// phrase) and produced messages like "Reserve failed:" with nothing after it.
async function parseErrorResponse<T extends ApiResponse>(
  response: Response,
  fallback: string
): Promise<T> {
  try {
    const body = (await response.json()) as T
    if (body && typeof body.error === 'string') {
      return body
    }
  } catch {
    // Body was not JSON; fall through to a synthesized error.
  }
  return {
    ok: false,
    error: `${fallback}: ${response.statusText || `HTTP ${response.status}`}`
  } as T
}

export async function searchUsernames(
  query: string,
  status?: string,
  page = 1,
  limit = 50,
  tag?: string,
  sort?: SearchSort
): Promise<SearchResult> {
  const params = new URLSearchParams({
    q: query,
    page: page.toString(),
    limit: limit.toString()
  })

  if (status) {
    params.set('status', status)
  }

  if (tag) {
    params.set('tag', tag)
  }

  if (sort) {
    params.set('sort', sort)
  }

  const response = await fetch(`${API_BASE}/usernames/search?${params}`)

  if (!response.ok) {
    throw new Error(`Search failed: ${response.statusText}`)
  }

  return response.json()
}

export async function getUsername(name: string): Promise<UsernameLookupResponse> {
  const response = await fetch(`${API_BASE}/username/${encodeURIComponent(name)}`)

  if (response.status === 404) {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      try {
        return await response.json()
      } catch {
        // Fall through to a stable typed 404 payload.
      }
    }

    return {
      ok: false,
      error: 'Username not found'
    }
  }

  if (!response.ok) {
    throw new Error(`Lookup failed: ${response.statusText}`)
  }

  return response.json()
}

export async function reserveUsername(
  name: string,
  reason: string,
  overrideReason?: string
): Promise<ReserveResponse> {
  const response = await fetch(`${API_BASE}/username/reserve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, reason, overrideReason })
  })

  if (!response.ok) {
    return parseErrorResponse<ReserveResponse>(response, 'Reserve failed')
  }

  return response.json()
}

export async function bulkReserveUsernames(
  names: string,
  reason: string
): Promise<BulkReserveResponse> {
  const response = await fetch(`${API_BASE}/username/reserve-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names, reason })
  })

  if (!response.ok) {
    return parseErrorResponse<BulkReserveResponse>(response, 'Bulk reserve failed')
  }

  return response.json()
}

export async function assignUsername(
  name: string,
  pubkey: string,
  overrideReason?: string
): Promise<AssignResponse> {
  const response = await fetch(`${API_BASE}/username/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pubkey, overrideReason })
  })

  if (!response.ok) {
    throw new Error(`Assign failed: ${response.statusText}`)
  }

  return response.json()
}

export async function revokeUsername(
  name: string,
  burn: boolean
): Promise<RevokeResponse> {
  const response = await fetch(`${API_BASE}/username/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, burn })
  })

  if (!response.ok) {
    throw new Error(`Revoke failed: ${response.statusText}`)
  }

  return response.json()
}

export async function getReservedWords(): Promise<ReservedWord[]> {
  const response = await fetch(`${API_BASE}/reserved-words`)

  if (!response.ok) {
    throw new Error(`Failed to fetch reserved words: ${response.statusText}`)
  }

  const data = await response.json()
  return data.words || []
}

export async function addReservedWord(
  word: string,
  category: string,
  reason?: string
): Promise<ApiResponse & { word?: string }> {
  const response = await fetch(`${API_BASE}/reserved-words`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word, category, reason })
  })

  if (!response.ok) {
    throw new Error(`Failed to add reserved word: ${response.statusText}`)
  }

  return response.json()
}

export async function notifyAssignment(
  name: string,
  email: string
): Promise<ApiResponse & { name?: string; email?: string }> {
  const response = await fetch(`${API_BASE}/notify-assignment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email })
  })

  if (!response.ok) {
    throw new Error(`Notify assignment failed: ${response.statusText}`)
  }

  return response.json()
}

export async function deleteReservedWord(word: string): Promise<ApiResponse> {
  const response = await fetch(`${API_BASE}/reserved-words/${encodeURIComponent(word)}`, {
    method: 'DELETE'
  })

  if (!response.ok) {
    throw new Error(`Failed to delete reserved word: ${response.statusText}`)
  }

  return response.json()
}

// --- Tags ---

export async function addTagToUsername(
  name: string,
  tag: string
): Promise<ApiResponse & { tags: string[]; tag_details: TagDetail[] }> {
  const response = await fetch(`${API_BASE}/username/${encodeURIComponent(name)}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  })

  if (!response.ok) {
    throw new Error(`Failed to add tag: ${response.statusText}`)
  }

  return response.json()
}

export async function removeTagFromUsername(
  name: string,
  tag: string
): Promise<ApiResponse & { tags: string[]; tag_details: TagDetail[] }> {
  const response = await fetch(
    `${API_BASE}/username/${encodeURIComponent(name)}/tags/${encodeURIComponent(tag)}`,
    { method: 'DELETE' }
  )

  if (!response.ok) {
    throw new Error(`Failed to remove tag: ${response.statusText}`)
  }

  return response.json()
}

export async function getAllTags(): Promise<{ tags: { tag: string; count: number }[] }> {
  const response = await fetch(`${API_BASE}/tags`)

  if (!response.ok) {
    throw new Error(`Failed to fetch tags: ${response.statusText}`)
  }

  return response.json()
}

// --- NIP-05 / Fastly KV Status ---

export async function getNip05Status(name: string): Promise<Nip05StatusResponse> {
  const response = await fetch(`${API_BASE}/username/${encodeURIComponent(name)}/nip05-status`)

  if (!response.ok) {
    throw new Error(`NIP-05 status check failed: ${response.statusText}`)
  }

  return response.json()
}

// --- Stats ---

export async function getUsernameStats(): Promise<UsernameStatsResponse> {
  const response = await fetch(`${API_BASE}/usernames/stats`)

  if (!response.ok) {
    throw new Error(`Stats failed: ${response.statusText}`)
  }

  return response.json()
}

export async function resyncToFastly(name: string): Promise<ResyncResponse> {
  const response = await fetch(`${API_BASE}/username/${encodeURIComponent(name)}/sync-to-fastly`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`Re-sync failed: ${response.statusText}`)
  }

  return response.json()
}

// --- Notes ---

export async function updateAdminNotes(
  name: string,
  adminNotes: string | null
): Promise<ApiResponse & {
  admin_notes: string | null
  admin_notes_updated_by?: string | null
  admin_notes_updated_at?: number | null
}> {
  const response = await fetch(`${API_BASE}/username/${encodeURIComponent(name)}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_notes: adminNotes }),
  })

  if (!response.ok) {
    throw new Error(`Update notes failed: ${response.statusText}`)
  }

  return response.json()
}

// --- Fastly KV Sync ---

export async function syncFastlyPage(
  cursor?: string | null,
  limit = 100,
  dryRun = false,
  signal?: AbortSignal
): Promise<FastlySyncPageResponse> {
  const response = await fetch(`${API_BASE}/sync/fastly`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      limit,
      cursor: cursor ?? undefined,
      dry_run: dryRun,
    }),
  })

  if (!response.ok) {
    throw new Error(`Fastly sync failed: ${response.statusText}`)
  }

  return response.json()
}
