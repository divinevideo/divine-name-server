import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import Login from '../pages/Login'

type AuthMethod = 'cf-access' | 'keycast'

interface AuthState {
  email: string
  pubkey: string | null
  method: AuthMethod | null
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be inside AuthProvider')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading')
  const [email, setEmail] = useState('')
  const [pubkey, setPubkey] = useState<string | null>(null)
  const [method, setMethod] = useState<AuthMethod | null>(null)

  useEffect(() => {
    fetch('/api/admin/auth/status')
      .then(r => r.json())
      .then(data => {
        if (data.authenticated) {
          setState('authenticated')
          setEmail(data.email || '')
          setPubkey(data.pubkey || null)
          setMethod(data.method || null)
        } else {
          setState('unauthenticated')
        }
      })
      .catch(() => {
        setState('unauthenticated')
      })
  }, [])

  const logout = () => {
    // CF Access sessions are JWTs injected by the edge; only Cloudflare can clear them.
    // Redirect the browser to CF Access's own logout endpoint; it tears down the
    // Access session cookie and bounces back. The Keycast session cookie (if any)
    // stays; we clear it server-side below as a belt-and-suspenders step first.
    if (method === 'cf-access') {
      fetch('/api/admin/auth/logout', { method: 'POST' }).finally(() => {
        window.location.href = '/cdn-cgi/access/logout'
      })
      return
    }

    fetch('/api/admin/auth/logout', { method: 'POST' })
      .then(() => {
        setState('unauthenticated')
        setEmail('')
        setPubkey(null)
        setMethod(null)
      })
  }

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  if (state === 'unauthenticated') {
    return <Login />
  }

  return (
    <AuthContext.Provider value={{ email, pubkey, method, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
