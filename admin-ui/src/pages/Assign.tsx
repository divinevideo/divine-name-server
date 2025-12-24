// ABOUTME: Assign username form component for admin interface
// ABOUTME: Allows admins to directly assign usernames to specific pubkeys (VIP onboarding)
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
  const [showOverrideConfirm, setShowOverrideConfirm] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')

  const isShortName = name.length > 0 && name.length < 3

  const handleSubmit = async (e: React.FormEvent) => {
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
      const result = await assignUsername(
        name,
        pubkey,
        isShortName ? overrideReason : undefined
      )

      if (result.ok) {
        setSuccess(true)
        setTimeout(() => navigate('/'), 2000)
      } else if (result.requiresOverride) {
        // Server says we need override - show confirmation
        setShowOverrideConfirm(true)
        setError(null)
      } else {
        setError(result.error || 'Failed to assign username')
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
            <label htmlFor="pubkey" className="block text-sm font-medium text-gray-700">
              Pubkey (hex or npub)
            </label>
            <input
              type="text"
              id="pubkey"
              value={pubkey}
              onChange={(e) => setPubkey(e.target.value)}
              required
              placeholder="npub1... or 64-character hex"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border font-mono text-xs"
            />
            <p className="mt-1 text-xs text-gray-500">
              npub1... format or 64-character hex pubkey
            </p>
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
                    "{name}" is only {name.length} character{name.length > 1 ? 's' : ''}. Short names are premium and require a reason for assignment.
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
                      placeholder="e.g., VIP user request, founder allocation, partnership agreement"
                      className="mt-1 block w-full rounded-md border-amber-300 shadow-sm focus:border-amber-500 focus:ring-amber-500 sm:text-sm px-3 py-2 border"
                    />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="submit"
                      disabled={loading || !overrideReason.trim()}
                      className="inline-flex items-center rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {loading ? 'Assigning...' : 'Confirm Override'}
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
                Username assigned successfully! Redirecting...
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
          )}
        </form>
      </div>
    </div>
  )
}
