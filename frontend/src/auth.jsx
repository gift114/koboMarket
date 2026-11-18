import { useEffect, useMemo, useState } from 'react'
import { api, clearSession, readSession, saveSession } from './api'
import { AuthContext } from './auth-context'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(() => Boolean(readSession().accessToken))
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    if (!readSession().accessToken) return

    api('/users/me')
      .then(({ data }) => setUser(data.user))
      .catch((error) => {
        if (error.status === 401) clearSession()
        setAuthError(error.message)
      })
      .finally(() => setLoading(false))
  }, [])

  async function login(credentials) {
    const { data } = await api('/auth/login', { method: 'POST', body: credentials, auth: false })
    saveSession(data)
    setUser(data.user)
    setAuthError('')
    return data.user
  }

  async function register(details) {
    const { data } = await api('/auth/register', { method: 'POST', body: details, auth: false })
    return data
  }

  async function logout() {
    const refreshToken = readSession().refreshToken
    try {
      if (refreshToken) {
        await api('/auth/logout', {
          method: 'POST',
          body: { refreshToken },
          auth: false,
        })
      }
    } finally {
      clearSession()
      setUser(null)
      setAuthError('')
    }
  }

  const value = useMemo(
    () => ({ user, loading, authError, login, register, logout, setUser }),
    [user, loading, authError],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
