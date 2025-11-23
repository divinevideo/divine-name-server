# Admin UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone React admin interface at admin.divine.video for managing usernames with search, reserve, assign, and revoke capabilities.

**Architecture:** React SPA with React Router served from the same Cloudflare Worker. Worker handles both API requests (existing admin endpoints + new search endpoint) and serves static React bundle. Search uses SQL LIKE queries with pagination for scalability.

**Tech Stack:** React 18, TypeScript, React Router v6, Tailwind CSS, Vite, Hono (worker framework), Cloudflare D1 (SQLite database)

---

## Task 1: Database Migration - Add Email Field

**Files:**
- Create: `migrations/0003_add_email_field.sql`

**Step 1: Create migration file**

Create `migrations/0003_add_email_field.sql`:

```sql
-- ABOUTME: Add email field to usernames table for admin search
-- ABOUTME: Create index for efficient LIKE queries on email

-- Add email column (optional field)
ALTER TABLE usernames ADD COLUMN email TEXT;

-- Create index for email lookups
CREATE INDEX IF NOT EXISTS idx_usernames_email ON usernames(email);
```

**Step 2: Test migration locally**

Run:
```bash
npx wrangler d1 migrations apply divine-name-server-db --local
```

Expected: Migration applies successfully, no errors

**Step 3: Verify schema update**

Run:
```bash
npx wrangler d1 execute divine-name-server-db --local --command "PRAGMA table_info(usernames)"
```

Expected: Output shows `email` column as TEXT type, nullable

**Step 4: Commit migration**

```bash
git add migrations/0003_add_email_field.sql
git commit -m "feat: add email field to usernames table"
```

---

## Task 2: Add Search API Endpoint

**Files:**
- Modify: `src/db/queries.ts` (add searchUsernames function)
- Modify: `src/routes/admin.ts` (add search endpoint)
- Modify: `src/db/queries.ts` (add SearchParams interface)

**Step 1: Add TypeScript interfaces for search**

In `src/db/queries.ts`, add after existing Username interface:

```typescript
export interface SearchParams {
  query: string
  status?: 'active' | 'reserved' | 'revoked' | 'burned'
  page?: number
  limit?: number
}

export interface SearchResult {
  results: Username[]
  pagination: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
}
```

**Step 2: Implement searchUsernames query function**

In `src/db/queries.ts`, add at the end:

```typescript
export async function searchUsernames(
  db: D1Database,
  params: SearchParams
): Promise<SearchResult> {
  const { query, status, page = 1, limit = 50 } = params
  const offset = (page - 1) * limit
  const searchPattern = `%${query}%`

  // Build WHERE clause
  let whereClause = `(name LIKE ? OR pubkey LIKE ? OR email LIKE ?)`
  const queryParams: any[] = [searchPattern, searchPattern, searchPattern]

  if (status) {
    whereClause += ` AND status = ?`
    queryParams.push(status)
  }

  // Get total count
  const countResult = await db.prepare(
    `SELECT COUNT(*) as count FROM usernames WHERE ${whereClause}`
  ).bind(...queryParams).first<{ count: number }>()

  const total = countResult?.count || 0
  const totalPages = Math.ceil(total / limit)

  // Get paginated results
  const results = await db.prepare(
    `SELECT * FROM usernames
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...queryParams, limit, offset).all<Username>()

  return {
    results: results.results,
    pagination: {
      page,
      limit,
      total,
      total_pages: totalPages
    }
  }
}
```

**Step 3: Add search endpoint to admin routes**

In `src/routes/admin.ts`, add this endpoint before the existing `/reserve` endpoint:

```typescript
admin.get('/usernames/search', async (c) => {
  try {
    const query = c.req.query('q')
    const status = c.req.query('status') as 'active' | 'reserved' | 'revoked' | 'burned' | undefined
    const page = parseInt(c.req.query('page') || '1')
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100)

    if (!query) {
      return c.json({ ok: false, error: 'Query parameter "q" is required' }, 400)
    }

    const result = await searchUsernames(c.env.DB, { query, status, page, limit })

    return c.json({
      ok: true,
      ...result
    })
  } catch (error) {
    console.error('Search error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})
```

**Step 4: Update imports in admin.ts**

At the top of `src/routes/admin.ts`, update the import line:

```typescript
import { reserveUsername, revokeUsername, assignUsername, getUsernameByName, searchUsernames } from '../db/queries'
```

**Step 5: Test search endpoint locally**

Run:
```bash
npx wrangler dev
```

In another terminal, test the endpoint:
```bash
curl "http://localhost:8787/api/admin/usernames/search?q=test&page=1&limit=10"
```

Expected: JSON response with `ok: true`, empty `results` array, pagination object

**Step 6: Commit search API**

```bash
git add src/db/queries.ts src/routes/admin.ts
git commit -m "feat: add username search API endpoint"
```

---

## Task 3: Initialize React Admin UI Project

**Files:**
- Create: `admin-ui/package.json`
- Create: `admin-ui/tsconfig.json`
- Create: `admin-ui/vite.config.ts`
- Create: `admin-ui/tailwind.config.js`
- Create: `admin-ui/postcss.config.js`
- Create: `admin-ui/index.html`
- Create: `admin-ui/src/main.tsx`
- Create: `admin-ui/src/App.tsx`
- Create: `admin-ui/src/index.css`

**Step 1: Create admin-ui directory and package.json**

```bash
mkdir admin-ui
cd admin-ui
```

Create `admin-ui/package.json`:

```json
{
  "name": "divine-admin-ui",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.15",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
```

**Step 2: Install dependencies**

Run:
```bash
cd admin-ui
npm install
```

Expected: All packages install successfully

**Step 3: Create TypeScript config**

Create `admin-ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Create `admin-ui/tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

**Step 4: Create Vite config**

Create `admin-ui/vite.config.ts`:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false
  }
})
```

**Step 5: Create Tailwind config**

Create `admin-ui/tailwind.config.js`:

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

Create `admin-ui/postcss.config.js`:

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

**Step 6: Create HTML entry point**

Create `admin-ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Divine Name Server - Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 7: Create base styles**

Create `admin-ui/src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
    'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

**Step 8: Create React entry point**

Create `admin-ui/src/main.tsx`:

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

**Step 9: Create basic App component**

Create `admin-ui/src/App.tsx`:

```typescript
function App() {
  return (
    <div className="min-h-screen bg-gray-100">
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-gray-900">
          Divine Name Server - Admin
        </h1>
        <p className="mt-4 text-gray-600">Admin interface loading...</p>
      </div>
    </div>
  )
}

export default App
```

**Step 10: Test React app builds**

Run:
```bash
cd admin-ui
npm run build
```

Expected: Build completes successfully, creates `admin-ui/dist/` directory

**Step 11: Commit React setup**

```bash
cd ..
git add admin-ui/
git commit -m "feat: initialize React admin UI with Vite and Tailwind"
```

---

## Task 4: Create TypeScript Types and API Client

**Files:**
- Create: `admin-ui/src/types/index.ts`
- Create: `admin-ui/src/api/client.ts`

**Step 1: Create TypeScript interfaces**

Create `admin-ui/src/types/index.ts`:

```typescript
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
```

**Step 2: Create API client**

Create `admin-ui/src/api/client.ts`:

```typescript
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
```

**Step 3: Commit types and API client**

```bash
git add admin-ui/src/types/ admin-ui/src/api/
git commit -m "feat: add TypeScript types and API client"
```

---

## Task 5: Build React Components - Layout and Navigation

**Files:**
- Create: `admin-ui/src/components/Layout.tsx`
- Create: `admin-ui/src/components/StatusBadge.tsx`

**Step 1: Create Layout component**

Create `admin-ui/src/components/Layout.tsx`:

```typescript
import { Link, Outlet, useLocation } from 'react-router-dom'

export default function Layout() {
  const location = useLocation()

  const isActive = (path: string) => location.pathname === path

  const navLinkClass = (path: string) =>
    `px-3 py-2 rounded-md text-sm font-medium ${
      isActive(path)
        ? 'bg-blue-700 text-white'
        : 'text-white hover:bg-blue-600'
    }`

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-blue-500 shadow-lg">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              <h1 className="text-xl font-bold text-white">
                Divine Name Server - Admin
              </h1>
            </div>
            <div className="flex space-x-4">
              <Link to="/" className={navLinkClass('/')}>
                Search
              </Link>
              <Link to="/reserve" className={navLinkClass('/reserve')}>
                Reserve
              </Link>
              <Link to="/assign" className={navLinkClass('/assign')}>
                Assign
              </Link>
              <Link to="/revoke" className={navLinkClass('/revoke')}>
                Revoke
              </Link>
              <Link to="/reserved-words" className={navLinkClass('/reserved-words')}>
                Reserved Words
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
```

**Step 2: Create StatusBadge component**

Create `admin-ui/src/components/StatusBadge.tsx`:

```typescript
interface StatusBadgeProps {
  status: 'active' | 'reserved' | 'revoked' | 'burned'
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const colors = {
    active: 'bg-green-100 text-green-800',
    reserved: 'bg-yellow-100 text-yellow-800',
    revoked: 'bg-gray-100 text-gray-800',
    burned: 'bg-red-100 text-red-800'
  }

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status]}`}>
      {status}
    </span>
  )
}
```

**Step 3: Commit components**

```bash
git add admin-ui/src/components/
git commit -m "feat: add Layout and StatusBadge components"
```

---

## Task 6: Build Dashboard Search Page

**Files:**
- Create: `admin-ui/src/pages/Dashboard.tsx`
- Create: `admin-ui/src/components/Pagination.tsx`

**Step 1: Create Pagination component**

Create `admin-ui/src/components/Pagination.tsx`:

```typescript
interface PaginationProps {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
}

export default function Pagination({ currentPage, totalPages, onPageChange }: PaginationProps) {
  return (
    <div className="flex items-center justify-between border-t border-gray-200 bg-white px-4 py-3 sm:px-6">
      <div className="flex flex-1 justify-between sm:hidden">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="relative inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="relative ml-3 inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
      <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-gray-700">
            Page <span className="font-medium">{currentPage}</span> of{' '}
            <span className="font-medium">{totalPages}</span>
          </p>
        </div>
        <div>
          <nav className="isolate inline-flex -space-x-px rounded-md shadow-sm" aria-label="Pagination">
            <button
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="relative inline-flex items-center rounded-l-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => onPageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="relative inline-flex items-center rounded-r-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </nav>
        </div>
      </div>
    </div>
  )
}
```

**Step 2: Create Dashboard page**

Create `admin-ui/src/pages/Dashboard.tsx`:

```typescript
import { useState, useEffect } from 'react'
import { searchUsernames } from '../api/client'
import type { Username } from '../types'
import StatusBadge from '../components/StatusBadge'
import Pagination from '../components/Pagination'

export default function Dashboard() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('')
  const [results, setResults] = useState<Username[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (query.length >= 2) {
      performSearch()
    } else {
      setResults([])
      setTotalPages(0)
      setTotal(0)
    }
  }, [query, status, currentPage])

  const performSearch = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await searchUsernames(query, status || undefined, currentPage, 50)
      setResults(data.results)
      setTotalPages(data.pagination.total_pages)
      setTotal(data.pagination.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  const truncate = (str: string | null, len: number) => {
    if (!str) return '-'
    return str.length > len ? str.substring(0, len) + '...' : str
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString()
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Search Usernames</h2>
        <p className="mt-1 text-sm text-gray-600">
          Search by username, pubkey, or email
        </p>
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="search" className="block text-sm font-medium text-gray-700">
              Search Query
            </label>
            <input
              type="text"
              id="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setCurrentPage(1)
              }}
              placeholder="Enter username, pubkey, or email..."
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            />
          </div>

          <div>
            <label htmlFor="status" className="block text-sm font-medium text-gray-700">
              Status Filter
            </label>
            <select
              id="status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setCurrentPage(1)
              }}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            >
              <option value="">All Statuses</option>
              <option value="active">Active</option>
              <option value="reserved">Reserved</option>
              <option value="revoked">Revoked</option>
              <option value="burned">Burned</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {loading && (
        <div className="text-center py-8">
          <p className="text-gray-500">Searching...</p>
        </div>
      )}

      {!loading && query.length >= 2 && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <p className="text-sm text-gray-700">
              Found <span className="font-medium">{total}</span> results
            </p>
          </div>

          {results.length === 0 ? (
            <div className="px-6 py-8 text-center">
              <p className="text-gray-500">No results found</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Username
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Pubkey
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Email
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Created
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {results.map((username) => (
                      <tr key={username.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                          {username.name}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                          {truncate(username.pubkey, 16)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {truncate(username.email, 30)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <StatusBadge status={username.status} />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {formatDate(username.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <Pagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageChange={setCurrentPage}
                />
              )}
            </>
          )}
        </div>
      )}

      {query.length < 2 && !loading && (
        <div className="text-center py-8 text-gray-500">
          <p>Enter at least 2 characters to search</p>
        </div>
      )}
    </div>
  )
}
```

**Step 3: Commit Dashboard**

```bash
git add admin-ui/src/pages/ admin-ui/src/components/Pagination.tsx
git commit -m "feat: add Dashboard search page with pagination"
```

---

## Task 7: Build Action Forms (Reserve, Assign, Revoke)

**Files:**
- Create: `admin-ui/src/pages/Reserve.tsx`
- Create: `admin-ui/src/pages/Assign.tsx`
- Create: `admin-ui/src/pages/Revoke.tsx`

**Step 1: Create Reserve page**

Create `admin-ui/src/pages/Reserve.tsx`:

```typescript
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { reserveUsername } from '../api/client'

export default function Reserve() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const result = await reserveUsername(name, reason)

      if (result.ok) {
        setSuccess(true)
        setTimeout(() => navigate('/'), 2000)
      } else {
        setError(result.error || 'Failed to reserve username')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Reserve Username</h2>
        <p className="mt-1 text-sm text-gray-600">
          Reserve a username to prevent user claims (brand protection, etc.)
        </p>
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Username
            </label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={3}
              maxLength={20}
              pattern="[a-z0-9]+"
              placeholder="alice"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            />
            <p className="mt-1 text-xs text-gray-500">
              3-20 characters, lowercase letters and numbers only
            </p>
          </div>

          <div>
            <label htmlFor="reason" className="block text-sm font-medium text-gray-700">
              Reason
            </label>
            <input
              type="text"
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              placeholder="Brand protection"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {success && (
            <div className="rounded-md bg-green-50 p-4">
              <p className="text-sm text-green-800">
                Username reserved successfully! Redirecting...
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={loading}
              className="inline-flex justify-center rounded-md border border-transparent bg-blue-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Reserving...' : 'Reserve Username'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="inline-flex justify-center rounded-md border border-gray-300 bg-white py-2 px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

**Step 2: Create Assign page**

Create `admin-ui/src/pages/Assign.tsx`:

```typescript
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { assignUsername } from '../api/client'

export default function Assign() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [pubkey, setPubkey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const result = await assignUsername(name, pubkey)

      if (result.ok) {
        setSuccess(true)
        setTimeout(() => navigate('/'), 2000)
      } else {
        setError(result.error || 'Failed to assign username')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Assign Username</h2>
        <p className="mt-1 text-sm text-gray-600">
          Directly assign a username to a specific pubkey (VIP onboarding)
        </p>
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Username
            </label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={3}
              maxLength={20}
              pattern="[a-z0-9]+"
              placeholder="alice"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            />
            <p className="mt-1 text-xs text-gray-500">
              3-20 characters, lowercase letters and numbers only
            </p>
          </div>

          <div>
            <label htmlFor="pubkey" className="block text-sm font-medium text-gray-700">
              Pubkey (hex)
            </label>
            <input
              type="text"
              id="pubkey"
              value={pubkey}
              onChange={(e) => setPubkey(e.target.value)}
              required
              minLength={64}
              maxLength={64}
              pattern="[0-9a-f]{64}"
              placeholder="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border font-mono text-xs"
            />
            <p className="mt-1 text-xs text-gray-500">
              64-character hex pubkey
            </p>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {success && (
            <div className="rounded-md bg-green-50 p-4">
              <p className="text-sm text-green-800">
                Username assigned successfully! Redirecting...
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={loading}
              className="inline-flex justify-center rounded-md border border-transparent bg-blue-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Assigning...' : 'Assign Username'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="inline-flex justify-center rounded-md border border-gray-300 bg-white py-2 px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

**Step 3: Create Revoke page**

Create `admin-ui/src/pages/Revoke.tsx`:

```typescript
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { revokeUsername } from '../api/client'

export default function Revoke() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [burn, setBurn] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const result = await revokeUsername(name, burn)

      if (result.ok) {
        setSuccess(true)
        setTimeout(() => navigate('/'), 2000)
      } else {
        setError(result.error || 'Failed to revoke username')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Revoke Username</h2>
        <p className="mt-1 text-sm text-gray-600">
          Revoke a username (recyclable) or permanently burn it
        </p>
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Username
            </label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={3}
              maxLength={20}
              pattern="[a-z0-9]+"
              placeholder="alice"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            />
          </div>

          <div className="flex items-start">
            <div className="flex items-center h-5">
              <input
                id="burn"
                type="checkbox"
                checked={burn}
                onChange={(e) => setBurn(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
            </div>
            <div className="ml-3 text-sm">
              <label htmlFor="burn" className="font-medium text-gray-700">
                Permanently burn this username
              </label>
              <p className="text-gray-500">
                If checked, this username can NEVER be claimed again. If unchecked, it can be reclaimed later.
              </p>
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {success && (
            <div className="rounded-md bg-green-50 p-4">
              <p className="text-sm text-green-800">
                Username {burn ? 'burned' : 'revoked'} successfully! Redirecting...
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={loading}
              className={`inline-flex justify-center rounded-md border border-transparent py-2 px-4 text-sm font-medium text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                burn
                  ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
                  : 'bg-yellow-600 hover:bg-yellow-700 focus:ring-yellow-500'
              }`}
            >
              {loading ? 'Processing...' : burn ? 'Burn Username' : 'Revoke Username'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="inline-flex justify-center rounded-md border border-gray-300 bg-white py-2 px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

**Step 4: Commit action forms**

```bash
git add admin-ui/src/pages/
git commit -m "feat: add Reserve, Assign, and Revoke forms"
```

---

## Task 8: Add Reserved Words Page and Endpoint

**Files:**
- Create: `admin-ui/src/pages/ReservedWords.tsx`
- Modify: `src/routes/admin.ts` (add reserved words endpoint)
- Modify: `src/db/queries.ts` (add getReservedWords function)

**Step 1: Add database query function**

In `src/db/queries.ts`, add at the end:

```typescript
export interface ReservedWord {
  word: string
  category: string
  reason: string | null
  created_at: number
}

export async function getReservedWords(
  db: D1Database
): Promise<ReservedWord[]> {
  const result = await db.prepare(
    'SELECT * FROM reserved_words ORDER BY category, word'
  ).all<ReservedWord>()

  return result.results
}
```

**Step 2: Add reserved words endpoint**

In `src/routes/admin.ts`, add before the `/reserve` endpoint:

```typescript
admin.get('/reserved-words', async (c) => {
  try {
    const words = await getReservedWords(c.env.DB)
    return c.json({ ok: true, words })
  } catch (error) {
    console.error('Reserved words error:', error)
    return c.json({ ok: false, error: 'Internal server error' }, 500)
  }
})
```

**Step 3: Update imports in admin.ts**

Update the import line to include `getReservedWords`:

```typescript
import { reserveUsername, revokeUsername, assignUsername, getUsernameByName, searchUsernames, getReservedWords } from '../db/queries'
```

**Step 4: Create ReservedWords page**

Create `admin-ui/src/pages/ReservedWords.tsx`:

```typescript
import { useState, useEffect } from 'react'
import { getReservedWords } from '../api/client'
import type { ReservedWord } from '../types'

export default function ReservedWords() {
  const [words, setWords] = useState<ReservedWord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadWords()
  }, [])

  const loadWords = async () => {
    try {
      const data = await getReservedWords()
      setWords(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reserved words')
    } finally {
      setLoading(false)
    }
  }

  const groupedByCategory = words.reduce((acc, word) => {
    if (!acc[word.category]) {
      acc[word.category] = []
    }
    acc[word.category].push(word)
    return acc
  }, {} as Record<string, ReservedWord[]>)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Reserved Words</h2>
        <p className="mt-1 text-sm text-gray-600">
          Protected words that cannot be claimed as usernames
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8">
          <p className="text-gray-500">Loading...</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedByCategory).map(([category, categoryWords]) => (
            <div key={category} className="bg-white shadow rounded-lg overflow-hidden">
              <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
                <h3 className="text-lg font-medium text-gray-900 capitalize">
                  {category}
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Word
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Reason
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {categoryWords.map((word) => (
                      <tr key={word.word}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                          {word.word}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {word.reason || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

**Step 5: Commit reserved words feature**

```bash
git add src/db/queries.ts src/routes/admin.ts admin-ui/src/pages/ReservedWords.tsx
git commit -m "feat: add reserved words endpoint and page"
```

---

## Task 9: Wire Up React Router

**Files:**
- Modify: `admin-ui/src/App.tsx`

**Step 1: Update App.tsx with router**

Replace `admin-ui/src/App.tsx` with:

```typescript
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Reserve from './pages/Reserve'
import Assign from './pages/Assign'
import Revoke from './pages/Revoke'
import ReservedWords from './pages/ReservedWords'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="reserve" element={<Reserve />} />
          <Route path="assign" element={<Assign />} />
          <Route path="revoke" element={<Revoke />} />
          <Route path="reserved-words" element={<ReservedWords />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
```

**Step 2: Test React app builds**

Run:
```bash
cd admin-ui
npm run build
```

Expected: Build succeeds, creates `dist/` folder

**Step 3: Test dev server**

Run:
```bash
cd admin-ui
npm run dev
```

Expected: Dev server starts, can access at http://localhost:5173

**Step 4: Commit router setup**

```bash
git add admin-ui/src/App.tsx
git commit -m "feat: wire up React Router with all pages"
```

---

## Task 10: Integrate React App with Worker

**Files:**
- Modify: `package.json` (add build script)
- Modify: `src/index.ts` (add static file serving)
- Create: `.gitignore` update for admin-ui/dist

**Step 1: Install hono static middleware**

Run:
```bash
npm install hono
```

Note: Already installed, just verify

**Step 2: Update worker to serve React app**

In `src/index.ts`, add after existing routes but before `export default app`:

```typescript
// Serve admin UI (must be after API routes to not interfere)
app.get('/admin/*', async (c) => {
  // For now, just return a placeholder
  // Will add proper static serving after build process is set up
  return c.json({ message: 'Admin UI coming soon' })
})
```

**Step 3: Add build script to root package.json**

In root `package.json`, update scripts section:

```json
"scripts": {
  "test": "vitest",
  "test:once": "vitest run",
  "build:admin": "cd admin-ui && npm run build",
  "dev": "wrangler dev",
  "deploy": "npm run build:admin && wrangler deploy"
}
```

**Step 4: Update .gitignore**

Add to `.gitignore`:

```
# Admin UI build output
admin-ui/dist/
admin-ui/node_modules/
```

**Step 5: Build admin UI**

Run:
```bash
npm run build:admin
```

Expected: Builds successfully, creates `admin-ui/dist/`

**Step 6: Commit worker integration prep**

```bash
git add package.json .gitignore src/index.ts
git commit -m "feat: prepare worker for admin UI integration"
```

---

## Task 11: Serve Static Files from Worker

**Files:**
- Modify: `wrangler.toml` (configure asset serving)
- Modify: `src/index.ts` (add proper static serving)

**Note:** Cloudflare Workers can serve static assets by including them in the deployment. We'll use Wrangler's asset configuration.

**Step 1: Update wrangler.toml**

Add to `wrangler.toml`:

```toml
# Serve admin UI static files
[site]
bucket = "./admin-ui/dist"
```

**Step 2: Update worker to serve assets**

Replace the placeholder admin route in `src/index.ts` with proper handling:

```typescript
// Admin UI routes - serve from static assets
// Note: When deployed with [site] config, Cloudflare automatically serves
// static files from the bucket. We just need to handle SPA routing fallback.

app.get('/admin/*', async (c) => {
  // This will be handled by Cloudflare's static asset serving
  // For SPA routing, all /admin/* paths should serve index.html
  return c.notFound()
})
```

Actually, with Wrangler's site configuration, we need a different approach. Let me revise:

**Step 2 (revised): Use proper asset serving**

The `[site]` configuration in wrangler.toml will automatically serve files from the dist directory. We need to configure it properly.

Update `wrangler.toml`:

```toml
name = "divine-name-server"
main = "src/index.ts"
compatibility_date = "2024-11-15"

[[d1_databases]]
binding = "DB"
database_name = "divine-name-server-db"
database_id = "e7e081c4-830d-449c-9de5-d93eaacefb34"

# Admin UI static assets
[assets]
directory = "./admin-ui/dist"
```

Note: The `[assets]` configuration requires Wrangler 3.x+. This will serve static files alongside the worker.

**Step 3: Handle SPA routing in worker**

Update `src/index.ts` to handle SPA routing properly. The admin routes need special handling:

Since assets are served automatically, we need to ensure API routes take precedence. The current route order should work:
1. API routes (handled first)
2. Everything else (falls through to static assets)

**Step 4: Test locally**

Run:
```bash
npm run build:admin
npx wrangler dev
```

Visit: http://localhost:8787/admin/
Expected: React app loads

Visit: http://localhost:8787/api/admin/usernames/search?q=test
Expected: API response (not static file)

**Step 5: Commit static serving**

```bash
git add wrangler.toml
git commit -m "feat: configure static asset serving for admin UI"
```

---

## Task 12: Apply Database Migration to Production

**Files:**
- None (database operation)

**Step 1: Apply migration to production database**

Run:
```bash
npx wrangler d1 migrations apply divine-name-server-db --remote
```

Expected: Migration 0003 applies successfully

**Step 2: Verify migration**

Run:
```bash
npx wrangler d1 execute divine-name-server-db --remote --command "PRAGMA table_info(usernames)"
```

Expected: Output shows `email` column

**Step 3: Document migration**

No git commit needed (database operation only)

---

## Task 13: Deploy to Production

**Files:**
- None (deployment operation)

**Step 1: Build admin UI**

Run:
```bash
npm run build:admin
```

Expected: Clean build, no errors

**Step 2: Deploy worker**

Run:
```bash
npx wrangler deploy
```

Expected: Deployment succeeds, outputs worker URL

**Step 3: Test production endpoints**

Test search API:
```bash
curl "https://divine-name-server.YOURSUBDOMAIN.workers.dev/api/admin/usernames/search?q=test"
```

Visit admin UI:
```
https://divine-name-server.YOURSUBDOMAIN.workers.dev/admin/
```

Expected: Both work

**Step 4: Document deployment**

No git commit needed

---

## Task 14: Configure Cloudflare Access

**Manual Steps (Dashboard):**

**Step 1: Navigate to Zero Trust Dashboard**

1. Go to Cloudflare dashboard
2. Click "Zero Trust" in left sidebar
3. Go to "Access" → "Applications"

**Step 2: Create Application**

1. Click "Add an application"
2. Choose "Self-hosted"
3. Fill in:
   - Application name: `Divine Name Server Admin`
   - Session Duration: `24 hours`
   - Application domain:
     - Subdomain: `admin`
     - Domain: `divine.video`
     - Path: `/*`

**Step 3: Add Access Policy**

1. Click "Next" to add policy
2. Policy name: `Admin Access Only`
3. Action: `Allow`
4. Include rules:
   - Add rule: `Emails`
   - Enter your email address
5. Click "Next" and "Add application"

**Step 4: Test Access**

1. Visit `https://admin.divine.video/`
2. Should see Cloudflare Access login page
3. Enter your email
4. Check email for verification code
5. After verifying, should see admin UI

**Step 5: Test API is also protected**

```bash
curl "https://admin.divine.video/api/admin/usernames/search?q=test"
```

Expected: Access denied (unless authenticated via browser session)

---

## Task 15: Configure Cloudflare Worker Routes

**Manual Steps (Dashboard):**

**Step 1: Navigate to Worker Routes**

1. Go to Cloudflare dashboard
2. Select `divine.video` domain
3. Go to "Workers Routes" in left sidebar

**Step 2: Add Route for Admin Subdomain**

1. Click "Add route"
2. Route: `admin.divine.video/*`
3. Worker: `divine-name-server`
4. Click "Save"

**Step 3: Verify Route Works**

Visit: `https://admin.divine.video/`
Expected: Admin UI loads (after Cloudflare Access authentication)

---

## Post-Deployment Testing

**Test Checklist:**

1. **Search Functionality**
   - [ ] Search by username finds results
   - [ ] Search by pubkey fragment works
   - [ ] Search by email works (if any emails in DB)
   - [ ] Status filter works (active, reserved, etc.)
   - [ ] Pagination works correctly
   - [ ] Empty search shows helpful message

2. **Reserve Username**
   - [ ] Can reserve new username
   - [ ] Reserved username appears in search
   - [ ] Reserved username cannot be claimed by users

3. **Assign Username**
   - [ ] Can assign username to pubkey
   - [ ] Assignment shows as active in search
   - [ ] User can access subdomain (username.divine.video)

4. **Revoke Username**
   - [ ] Can revoke without burn (recyclable)
   - [ ] Can burn permanently
   - [ ] Revoked status shows correctly
   - [ ] Burned username cannot be reclaimed

5. **Reserved Words**
   - [ ] Page loads all reserved words
   - [ ] Grouped by category correctly
   - [ ] Shows system, brand, protocol words

6. **Security**
   - [ ] Admin UI requires Cloudflare Access login
   - [ ] API endpoints require authentication
   - [ ] Unauthenticated requests are blocked

---

## Rollback Plan

**If deployment fails:**

1. **Revert worker deployment:**
   ```bash
   npx wrangler rollback
   ```

2. **Revert database migration (if needed):**
   - There's no automatic rollback for D1 migrations
   - Email field is nullable, so it won't break existing functionality
   - Can manually remove: `ALTER TABLE usernames DROP COLUMN email`

3. **Remove Cloudflare Access:**
   - Go to Zero Trust → Applications
   - Delete "Divine Name Server Admin" application

---

## Future Enhancements

Not included in this implementation:

1. **Full-Text Search (FTS5)** - Better performance for millions of records
2. **Bulk Operations** - Reserve/revoke multiple names at once
3. **Audit Log** - Track all admin actions with timestamps
4. **Email Validation** - Verify email format on claim endpoint
5. **Export to CSV** - Download search results
6. **Real-time Updates** - WebSocket for live username changes
7. **User Profile Links** - Click username to open divine.video profile
8. **Advanced Filters** - Date ranges, regex search, etc.
