import axios from 'axios'

export const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use(config => {
  const raw = localStorage.getItem('iam-auth')
  if (raw) {
    try {
      const { state } = JSON.parse(raw) as { state: { token: string | null } }
      if (state.token) config.headers.Authorization = `Bearer ${state.token}`
    } catch {
      // ignore
    }
  }
  return config
})

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('iam-auth')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  },
)
