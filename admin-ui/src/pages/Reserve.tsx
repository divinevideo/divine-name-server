// ABOUTME: Reserve username form component for admin interface
// ABOUTME: Allows admins to reserve usernames (single or bulk) with reason tracking
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { reserveUsername, bulkReserveUsernames } from '../api/client'
import type { BulkReserveResult } from '../types'

export default function Reserve() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'single' | 'bulk'>('single')

  // Single mode state
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Bulk mode state
  const [names, setNames] = useState('')
  const [bulkReason, setBulkReason] = useState('')
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [bulkResults, setBulkResults] = useState<BulkReserveResult[] | null>(null)

  const handleSingleSubmit = async (e: React.FormEvent) => {
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

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBulkLoading(true)
    setBulkError(null)
    setBulkResults(null)

    try {
      const result = await bulkReserveUsernames(names, bulkReason)

      if (result.ok) {
        setBulkResults(result.results || [])
      } else {
        setBulkError(result.error || 'Failed to reserve usernames')
      }
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBulkLoading(false)
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Reserve Usernames</h2>
        <p className="mt-1 text-sm text-gray-600">
          Reserve usernames to prevent user claims (brand protection, etc.)
        </p>
      </div>

      {/* Mode Tabs */}
      <div className="mb-6">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setMode('single')}
              className={`${
                mode === 'single'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
            >
              Single
            </button>
            <button
              onClick={() => setMode('bulk')}
              className={`${
                mode === 'bulk'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
            >
              Bulk
            </button>
          </nav>
        </div>
      </div>

      {/* Single Mode Form */}
      {mode === 'single' && (
        <div className="bg-white shadow rounded-lg p-6">
          <form onSubmit={handleSingleSubmit} className="space-y-6">
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
                minLength={1}
                maxLength={63}
                pattern="^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"
                placeholder="alice or MrBeast"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
              />
              <p className="mt-1 text-xs text-gray-500">
                1-63 characters, letters, numbers, and hyphens only. Cannot start or end with hyphen. Case-insensitive matching.
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
      )}

      {/* Bulk Mode Form */}
      {mode === 'bulk' && (
        <div className="bg-white shadow rounded-lg p-6">
          <form onSubmit={handleBulkSubmit} className="space-y-6">
            <div>
              <label htmlFor="names" className="block text-sm font-medium text-gray-700">
                Usernames
              </label>
              <textarea
                id="names"
                value={names}
                onChange={(e) => setNames(e.target.value)}
                required
                rows={10}
                placeholder="alice, bob, charlie&#10;@dave @eve&#10;frank"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border font-mono"
              />
              <p className="mt-1 text-xs text-gray-500">
                Separate with commas, spaces, or line breaks. @ symbols automatically stripped. Max 1000 per request.
              </p>
            </div>

            <div>
              <label htmlFor="bulkReason" className="block text-sm font-medium text-gray-700">
                Reason
              </label>
              <input
                type="text"
                id="bulkReason"
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
                required
                placeholder="Brand protection"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
              />
            </div>

            {bulkError && (
              <div className="rounded-md bg-red-50 p-4">
                <p className="text-sm text-red-800">{bulkError}</p>
              </div>
            )}

            {bulkResults && (
              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="rounded-md bg-green-50 p-4 flex-1">
                    <p className="text-sm font-medium text-green-800">
                      ✓ {bulkResults.filter(r => r.success).length} successful
                    </p>
                  </div>
                  {bulkResults.filter(r => !r.success).length > 0 && (
                    <div className="rounded-md bg-red-50 p-4 flex-1">
                      <p className="text-sm font-medium text-red-800">
                        ✗ {bulkResults.filter(r => !r.success).length} failed
                      </p>
                    </div>
                  )}
                </div>

                <div className="border rounded-lg overflow-hidden">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Username
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Details
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {bulkResults.map((result, index) => (
                        <tr key={index} className={result.success ? 'bg-white' : 'bg-red-50'}>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                            {result.name}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm">
                            {result.success ? (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                {result.status}
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                                failed
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-500">
                            {result.error || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setNames('')
                    setBulkResults(null)
                  }}
                  className="inline-flex justify-center rounded-md border border-gray-300 bg-white py-2 px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  Reserve More
                </button>
              </div>
            )}

            {!bulkResults && (
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={bulkLoading}
                  className="inline-flex justify-center rounded-md border border-transparent bg-blue-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {bulkLoading ? 'Reserving...' : 'Reserve Usernames'}
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="inline-flex justify-center rounded-md border border-gray-300 bg-white py-2 px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  Cancel
                </button>
              </div>
            )}
          </form>
        </div>
      )}
    </div>
  )
}
