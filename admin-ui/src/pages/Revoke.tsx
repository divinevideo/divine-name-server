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
