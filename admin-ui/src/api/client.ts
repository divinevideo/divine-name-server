import type {
  SearchResult,
  ReserveResponse,
  AssignResponse,
  RevokeResponse,
  ReservedWord,
  BulkReserveResponse,
  ApiResponse
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
  reason: string,
  overrideReason?: string
): Promise<ReserveResponse> {
  const response = await fetch(`${API_BASE}/username/reserve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, reason, overrideReason })
  })

  if (!response.ok) {
    throw new Error(`Reserve failed: ${response.statusText}`)
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
    throw new Error(`Bulk reserve failed: ${response.statusText}`)
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

export async function deleteReservedWord(word: string): Promise<ApiResponse> {
  const response = await fetch(`${API_BASE}/reserved-words/${encodeURIComponent(word)}`, {
    method: 'DELETE'
  })

  if (!response.ok) {
    throw new Error(`Failed to delete reserved word: ${response.statusText}`)
  }

  return response.json()
}
