import type {
  SearchResult,
  ReserveResponse,
  AssignResponse,
  RevokeResponse,
  ReservedWord
} from '../types'

const API_BASE = '/api/admin'

export async function searchUsernames(
  query: string,
  status?: string,
  page = 1,
  limit = 50
): Promise<SearchResult> {
  const params = new URLSearchParams({
    q: query,
    page: page.toString(),
    limit: limit.toString()
  })

  if (status) {
    params.set('status', status)
  }

  const response = await fetch(`${API_BASE}/usernames/search?${params}`)

  if (!response.ok) {
    throw new Error(`Search failed: ${response.statusText}`)
  }

  return response.json()
}

export async function reserveUsername(
  name: string,
  reason: string
): Promise<ReserveResponse> {
  const response = await fetch(`${API_BASE}/username/reserve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, reason })
  })

  if (!response.ok) {
    throw new Error(`Reserve failed: ${response.statusText}`)
  }

  return response.json()
}

export async function assignUsername(
  name: string,
  pubkey: string
): Promise<AssignResponse> {
  const response = await fetch(`${API_BASE}/username/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pubkey })
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
  // Note: This endpoint doesn't exist yet, will need to add it
  const response = await fetch(`${API_BASE}/reserved-words`)

  if (!response.ok) {
    throw new Error(`Failed to fetch reserved words: ${response.statusText}`)
  }

  const data = await response.json()
  return data.words || []
}
