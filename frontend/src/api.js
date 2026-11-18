const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1'
let refreshPromise

export const readSession = () => ({
  accessToken: sessionStorage.getItem('kobomarket.accessToken'),
  refreshToken: sessionStorage.getItem('kobomarket.refreshToken'),
})

export function saveSession(session) {
  sessionStorage.setItem('kobomarket.accessToken', session.accessToken)
  sessionStorage.setItem('kobomarket.refreshToken', session.refreshToken)
}

export function clearSession() {
  sessionStorage.removeItem('kobomarket.accessToken')
  sessionStorage.removeItem('kobomarket.refreshToken')
}

export function idempotencyKey() {
  return crypto.randomUUID()
}

export function formatNaira(kobo = 0) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(Number(kobo) / 100)
}

export async function api(path, options = {}) {
  const { method = 'GET', body, headers = {}, auth = true, retry = false } = options
  const session = readSession()
  const requestHeaders = { ...headers }

  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json'
  if (auth && session.accessToken) requestHeaders.Authorization = `Bearer ${session.accessToken}`

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 401 && auth && !retry && session.refreshToken) {
    try {
      if (!refreshPromise) {
        refreshPromise = api('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: session.refreshToken },
          auth: false,
          retry: true,
        })
          .then((refreshed) => saveSession(refreshed.data))
          .finally(() => { refreshPromise = undefined })
      }
      await refreshPromise
      return api(path, { ...options, retry: true })
    } catch (error) {
      clearSession()
      throw error
    }
  }

  if (response.status === 401 && auth && (retry || !session.refreshToken)) clearSession()

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    const message = response.status === 502 || response.status === 504
      ? 'The marketplace API is unavailable. Start the backend on port 3000 and try again.'
      : `The API returned an unexpected response (${response.status}).`
    const error = new Error(message)
    error.status = response.status
    throw error
  }

  const payload = await response.json()
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Something went wrong. Please try again.')
    error.status = response.status
    error.code = payload?.error?.code
    error.details = payload?.error?.details
    throw error
  }

  return payload
}
