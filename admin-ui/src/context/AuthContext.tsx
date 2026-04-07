import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import Login from '../pages/Login'

interface AuthState {
  email: string
  pubkey: string | null
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

  useEffect(() => {
    fetch('/api/admin/auth/status')
      .then(r => r.json())
      .then(data => {
        if (data.authenticated) {
          setState('authenticated')
          setEmail(data.email || '')
          setPubkey(data.pubkey || null)
        } else {
          setState('unauthenticated')
        }
      })
      .catch(() => {
        // Auth check failed -- might be CF Access handling it, try loading normally
        setState('authenticated')
        setEmail('')
      })
  }, [])

  const logout = () => {
    fetch('/api/admin/auth/logout', { method: 'POST' })
      .then(() => {
        setState('unauthenticated')
        setEmail('')
        setPubkey(null)
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
    <AuthContext.Provider value={{ email, pubkey, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
