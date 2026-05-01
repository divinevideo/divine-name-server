import { useEffect, useState } from 'react'

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  missing_params: 'OAuth callback was missing required parameters. Try signing in again.',
  not_configured: 'OAuth is not configured on this environment. Contact an administrator.',
  token_exchange_failed: 'Sign-in failed at the token exchange step. The state may have expired; try again.',
  access_denied: 'You declined the sign-in request.',
}

function describeAuthError(code: string): string {
  return AUTH_ERROR_MESSAGES[code] ?? `Sign-in failed: ${code}`
}

export default function Login() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Surface OAuth callback errors that land in the URL as ?auth_error=<code>.
  // Clean the query string after reading so a refresh doesn't re-show a stale error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('auth_error')
    if (code) {
      setError(describeAuthError(code))
      params.delete('auth_error')
      params.delete('auth_success')
      const cleanSearch = params.toString()
      const cleanUrl = `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}${window.location.hash}`
      window.history.replaceState({}, '', cleanUrl)
    }
  }, [])

  const handleLogin = async () => {
    setLoading(true)
    setError(null)

    try {
      const resp = await fetch('/api/admin/auth/start', { method: 'POST' })
      const data = await resp.json()

      if (data.authorize_url) {
        window.location.href = data.authorize_url
      } else {
        setError(data.error || 'OAuth not configured')
        setLoading(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="max-w-sm w-full text-center">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Name Server Admin</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in to manage usernames</p>
        </div>

        <button
          onClick={handleLogin}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
          {loading ? 'Connecting...' : 'Sign in with Keycast'}
        </button>

        {error && (
          <p className="mt-3 text-sm text-red-600">{error}</p>
        )}
      </div>
    </div>
  )
}
