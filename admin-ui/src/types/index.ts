export type ClaimSource = 'self-service' | 'admin' | 'bulk-upload' | 'vine-import' | 'public-reservation' | 'unknown'
export type SearchSort = 'relevance' | 'newest' | 'oldest' | 'updated'

export interface Username {
  id: number
  name: string
  username_display?: string | null
  username_canonical?: string | null
  pubkey: string | null
  email: string | null
  relays: string | null
  status: 'active' | 'reserved' | 'revoked' | 'burned' | 'pending-confirmation'
  recyclable: number
  created_at: number
  updated_at: number
  claimed_at: number | null
  revoked_at: number | null
  reserved_reason: string | null
  admin_notes: string | null
  claim_source: ClaimSource
  created_by: string | null
  tags: string[]
}

export interface UsernameStats {
  totals: {
    all: number
    active: number
    reserved: number
    revoked: number
    burned: number
  }
  metadata: {
    with_notes: number
    with_tags: number
    untagged: number
    vip: number
  }
  activity: {
    claimed_7d: number
    claimed_30d: number
    updated_7d: number
    updated_30d: number
  }
  top_tags: Array<{
    tag: string
    count: number
  }>
}

export interface SearchResult {
  ok: boolean
  results: Username[]
  pagination: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
}

export interface ApiResponse {
  ok: boolean
  error?: string
}

export interface UsernameDetailResponse extends ApiResponse {
  username: Username
}

export interface UsernameStatsResponse extends ApiResponse, UsernameStats {}

export interface UsernameMetadataResponse extends ApiResponse {
  username: Username
}

export interface ReserveResponse extends ApiResponse {
  name?: string
  status?: string
  requiresOverride?: boolean
}

export interface AssignResponse extends ApiResponse {
  name?: string
  pubkey?: string
  status?: string
  requiresOverride?: boolean
}

export interface RevokeResponse extends ApiResponse {
  name?: string
  status?: string
  recyclable?: boolean
}

export interface ReservedWord {
  word: string
  category: string
  reason: string | null
  created_at: number
}

export interface BulkReserveResult {
  name: string
  status: string
  success: boolean
  error?: string
}

export interface BulkReserveResponse extends ApiResponse {
  total?: number
  successful?: number
  failed?: number
  results?: BulkReserveResult[]
}
