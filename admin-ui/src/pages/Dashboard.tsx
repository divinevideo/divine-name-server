// ABOUTME: Main admin dashboard page for searching and viewing usernames
// ABOUTME: Supports metadata-aware search, operational stats, and pagination

import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getUsernameStats, searchUsernames } from '../api/client'
import type { SearchSort, Username, UsernameStats } from '../types'
import StatusBadge from '../components/StatusBadge'
import Pagination from '../components/Pagination'

const SORT_OPTIONS: Array<{ value: SearchSort; label: string }> = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'updated', label: 'Recently Updated' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' }
]

export default function Dashboard() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('')
  const [sort, setSort] = useState<SearchSort>('relevance')
  const [results, setResults] = useState<Username[]>([])
  const [stats, setStats] = useState<UsernameStats | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const performSearch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await searchUsernames(query, status || undefined, sort, currentPage, 50)
      setResults(data.results)
      setTotalPages(data.pagination.total_pages)
      setTotal(data.pagination.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [query, status, sort, currentPage])

  const loadStats = useCallback(async () => {
    try {
      const data = await getUsernameStats()
      setStats(data)
    } catch (err) {
      console.error('Stats failed:', err)
    }
  }, [])

  useEffect(() => {
    performSearch()
  }, [query, status, sort, currentPage, performSearch])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  const truncate = (str: string | null, len: number) => {
    if (!str) return '-'
    return str.length > len ? str.substring(0, len) + '...' : str
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString()
  }

  const statCards = stats ? [
    { label: 'All Names', value: stats.totals.all, tone: 'bg-slate-50 border-slate-200 text-slate-900' },
    { label: 'Active', value: stats.totals.active, tone: 'bg-green-50 border-green-200 text-green-900' },
    { label: 'Reserved', value: stats.totals.reserved, tone: 'bg-yellow-50 border-yellow-200 text-yellow-900' },
    { label: 'With Notes', value: stats.metadata.with_notes, tone: 'bg-blue-50 border-blue-200 text-blue-900' },
    { label: 'With Tags', value: stats.metadata.with_tags, tone: 'bg-indigo-50 border-indigo-200 text-indigo-900' },
    { label: 'Untagged', value: stats.metadata.untagged, tone: 'bg-orange-50 border-orange-200 text-orange-900' },
    { label: 'VIP', value: stats.metadata.vip, tone: 'bg-purple-50 border-purple-200 text-purple-900' },
    { label: 'Updated 30d', value: stats.activity.updated_30d, tone: 'bg-emerald-50 border-emerald-200 text-emerald-900' }
  ] : []

  const downloadSearchResultsCSV = () => {
    if (results.length === 0) return

    const headers = ['Username', 'Tags', 'Notes', 'Pubkey', 'Email', 'Status', 'Created', 'Source', 'Created By']
    const rows = results.map((username: Username) => [
      username.name,
      username.tags.join('; '),
      username.admin_notes || '',
      username.pubkey || '',
      username.email || '',
      username.status,
      formatDate(username.created_at),
      username.claim_source,
      username.created_by || ''
    ])

    const csvContent = [
      headers.join(','),
      ...rows.map((row: (string | number)[]) => row.map((cell: string | number) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    link.setAttribute('href', url)
    link.setAttribute('download', `search-results-${new Date().toISOString().split('T')[0]}.csv`)
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Search Usernames</h2>
        <p className="mt-1 text-sm text-gray-600">
          Search by username, pubkey, email, tags, or internal notes
        </p>
      </div>

      {stats && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {statCards.map((card) => (
              <div key={card.label} className={`rounded-lg border p-4 ${card.tone}`}>
                <p className="text-xs font-semibold uppercase tracking-[0.18em]">{card.label}</p>
                <p className="mt-2 text-2xl font-bold">{card.value}</p>
              </div>
            ))}
          </div>

          {stats.top_tags.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Top Tags</h3>
                  <p className="text-xs text-gray-500">Common labels across internal operations.</p>
                </div>
                <p className="text-xs text-gray-500">
                  Claims 30d: <span className="font-semibold text-gray-700">{stats.activity.claimed_30d}</span>
                </p>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {stats.top_tags.map((tag) => (
                  <span
                    key={tag.tag}
                    className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700"
                  >
                    {tag.tag} <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-[11px] text-gray-500">{tag.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-white shadow rounded-lg p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
              <option value="recovered">Recovered (Vine)</option>
              <option value="revoked">Revoked</option>
              <option value="burned">Burned</option>
            </select>
          </div>

          <div>
            <label htmlFor="sort" className="block text-sm font-medium text-gray-700">
              Sort
            </label>
            <select
              id="sort"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as SearchSort)
                setCurrentPage(1)
              }}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* CSV Export Links */}
        <div className="mt-4 pt-4 border-t border-gray-200">
          <p className="text-sm font-medium text-gray-700 mb-2">Export as CSV:</p>
          <div className="flex flex-wrap gap-2">
            <a
              href="/api/admin/export/csv"
              download="usernames-all.csv"
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              All Names
            </a>
            <a
              href="/api/admin/export/csv?status=active"
              download="usernames-active.csv"
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-green-100 text-green-700 hover:bg-green-200"
            >
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Active
            </a>
            <a
              href="/api/admin/export/csv?status=recovered"
              download="usernames-recovered.csv"
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-purple-100 text-purple-700 hover:bg-purple-200"
            >
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Recovered (Vine)
            </a>
            <a
              href="/api/admin/export/csv?status=reserved"
              download="usernames-reserved.csv"
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-yellow-100 text-yellow-700 hover:bg-yellow-200"
            >
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Reserved
            </a>
            <a
              href="/api/admin/export/csv?status=revoked"
              download="usernames-revoked.csv"
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-orange-100 text-orange-700 hover:bg-orange-200"
            >
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Revoked
            </a>
            <a
              href="/api/admin/export/csv?status=burned"
              download="usernames-burned.csv"
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-red-100 text-red-700 hover:bg-red-200"
            >
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Burned
            </a>
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

      {!loading && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <p className="text-sm text-gray-700">
              Found <span className="font-medium">{total}</span> results
            </p>
            {results.length > 0 && (
              <button
                type="button"
                onClick={downloadSearchResultsCSV}
                className="inline-flex items-center rounded-md border border-gray-300 bg-white py-2 px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Download Search Results CSV
              </button>
            )}
          </div>

          {results.length === 0 ? (
            <div className="px-6 py-8 text-center">
              <p className="text-gray-500">No results matched names, pubkeys, emails, tags, or notes.</p>
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
                        Tags
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
                        Source
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Created
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {results.map((username) => (
                      <tr
                        key={username.id}
                        onClick={() => navigate(`/username/${username.name}`)}
                        className="hover:bg-blue-50 cursor-pointer"
                      >
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-blue-600 hover:text-blue-800">
                          <div className="space-y-2">
                            <div>{username.name}</div>
                            {username.admin_notes && (
                              <p className="max-w-xs whitespace-normal text-xs font-normal text-gray-500">
                                {truncate(username.admin_notes, 80)}
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {username.tags.length > 0 ? (
                            <div className="flex max-w-xs flex-wrap gap-1">
                              {username.tags.map((tag) => (
                                <span
                                  key={`${username.id}-${tag}`}
                                  className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs italic text-gray-400">No tags</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                          {truncate(username.pubkey, 16)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {truncate(username.email, 30)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <StatusBadge
                            status={username.status}
                            isRecovered={username.status === 'active' && !!username.pubkey && !!username.reserved_reason?.toLowerCase().includes('vine')}
                          />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {username.claim_source}
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
    </div>
  )
}
