import axios, { AxiosInstance } from 'axios'
import { useAuthStore } from '@/store/auth.store'
import { env } from './env'

interface ClientOptions {
  /**
   * Authoritative clients (= IAM) trigger session logout on 401. All other
   * backends (workgraph, composer, context-fabric) currently issue their own
   * tokens or are open; a 401 from them does NOT mean the user's IAM session
   * is invalid, so we only surface the error to the calling tile.
   */
  authoritative?: boolean
}

function makeClient(baseURL: string, opts: ClientOptions = {}): AxiosInstance {
  const client = axios.create({ baseURL })
  client.interceptors.request.use((cfg) => {
    const token = useAuthStore.getState().token
    if (token) cfg.headers.Authorization = `Bearer ${token}`
    return cfg
  })
  client.interceptors.response.use(
    (res) => res,
    (err) => {
      if (err?.response?.status === 401 && opts.authoritative) {
        useAuthStore.getState().logout()
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
          window.location.href = '/login'
        }
      }
      return Promise.reject(err)
    },
  )
  return client
}

// Only IAM is the authoritative session source.
export const iamApi = makeClient(env.iamBase, { authoritative: true })
export const workgraphApi = makeClient(env.workgraphBase)
export const runtimeApi = makeClient(env.runtimeBase)
export const composerApi = makeClient(env.composerBase)
// context-fabric has no auth today; same axios for consistency.
export const contextFabricApi = makeClient(env.contextFabricBase)
export const mcpApi = makeClient(env.mcpBase)
export const auditGovApi = makeClient(env.auditGovBase)
