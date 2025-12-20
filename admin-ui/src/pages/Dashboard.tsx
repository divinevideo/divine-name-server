// ABOUTME: Main admin dashboard page for searching and viewing usernames
// ABOUTME: Supports search by username/pubkey/email with status filtering and pagination

import { useState, useEffect, useCallback } from 'react'
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

  const performSearch = useCallback(async () => {
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
  }, [query, status, currentPage])

  useEffect(() => {
    performSearch()
  }, [query, status, currentPage, performSearch])

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

      {!loading && (
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
    </div>
  )
}
