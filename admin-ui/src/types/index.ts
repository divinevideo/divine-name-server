export interface Username {
  id: number
  name: string
  pubkey: string | null
  email: string | null
  relays: string | null
  status: 'active' | 'reserved' | 'revoked' | 'burned'
  recyclable: number
  created_at: number
  updated_at: number
  claimed_at: number | null
  revoked_at: number | null
  reserved_reason: string | null
  admin_notes: string | null
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

export interface ReserveResponse extends ApiResponse {
  name?: string
  status?: string
}

export interface AssignResponse extends ApiResponse {
  name?: string
  pubkey?: string
  status?: string
}

export interface RevokeResponse extends ApiResponse {
  name?: string
  status?: string
  recyclable?: boolean
}

export interface ReservedWord {
  word: string
  category: string
  reason: string
  created_at: number
}
