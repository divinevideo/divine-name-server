// ABOUTME: Reserve username form component for admin interface
// ABOUTME: Allows admins to reserve usernames (single or bulk) with override for short names
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
  const [successStatus, setSuccessStatus] = useState<string>('reserved')
  const [showOverrideConfirm, setShowOverrideConfirm] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')

  // Bulk mode state
  const [names, setNames] = useState('')
  const [bulkReason, setBulkReason] = useState('')
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [bulkResults, setBulkResults] = useState<BulkReserveResult[] | null>(null)

  const isShortName = name.length > 0 && name.length < 3

  const handleSingleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // If it's a short name and we haven't confirmed yet, show confirmation
    if (isShortName && !showOverrideConfirm) {
      setShowOverrideConfirm(true)
      return
    }

    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const result = await reserveUsername(
        name,
        reason,
        isShortName ? overrideReason : undefined
      )

      if (result.ok) {
        setSuccess(true)
        setSuccessStatus(result.status || 'reserved')
        setTimeout(() => navigate('/'), 2000)
      } else if (result.requiresOverride) {
        setShowOverrideConfirm(true)
        setError(null)
      } else {
        setError(result.error || 'Failed to reserve username')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  const handleCancelOverride = () => {
    setShowOverrideConfirm(false)
    setOverrideReason('')
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
                onChange={(e) => {
                  setName(e.target.value.toLowerCase())
                  setShowOverrideConfirm(false)
                  setOverrideReason('')
                }}
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

            {/* Override Confirmation Dialog */}
            {showOverrideConfirm && (
              <div className="rounded-md bg-amber-50 border border-amber-200 p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3 flex-1">
                    <h3 className="text-sm font-medium text-amber-800">
                      Short Name Override Required
                    </h3>
                    <p className="mt-1 text-sm text-amber-700">
                      "{name}" is only {name.length} character{name.length > 1 ? 's' : ''}. Short names are premium and require a reason for reservation.
                    </p>
                    <div className="mt-3">
                      <label htmlFor="overrideReason" className="block text-sm font-medium text-amber-800">
                        Override Reason *
                      </label>
                      <textarea
                        id="overrideReason"
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        required
                        rows={2}
                        placeholder="e.g., VIP reservation, founder allocation, partnership agreement"
                        className="mt-1 block w-full rounded-md border-amber-300 shadow-sm focus:border-amber-500 focus:ring-amber-500 sm:text-sm px-3 py-2 border"
                      />
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="submit"
                        disabled={loading || !overrideReason.trim()}
                        className="inline-flex items-center rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loading ? 'Reserving...' : 'Confirm Override'}
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelOverride}
                        className="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-md bg-red-50 p-4">
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            {success && (
              <div className="rounded-md bg-green-50 p-4">
                <p className="text-sm text-green-800">
                  {successStatus === 'already reserved'
                    ? 'Username is already reserved. Redirecting...'
                    : 'Username reserved successfully! Redirecting...'}
                </p>
              </div>
            )}

            {!showOverrideConfirm && (
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
            )}
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
                Separate with commas, spaces, or line breaks. @ symbols automatically stripped. Max 1000 per request. Short names (1-2 chars) will fail in bulk mode.
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
                      {bulkResults.filter(r => r.success).length} successful
                    </p>
                  </div>
                  {bulkResults.filter(r => !r.success).length > 0 && (
                    <div className="rounded-md bg-red-50 p-4 flex-1">
                      <p className="text-sm font-medium text-red-800">
                        {bulkResults.filter(r => !r.success).length} failed
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
