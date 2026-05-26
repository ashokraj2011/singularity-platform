import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { LoopTheater } from './loop-theater/LoopTheater'
import './styles.css'

// Recognise the transient browser-side errors that should be retried
// silently rather than surfaced as user-visible failures. macOS App Nap
// and Chrome's background-tab freezer suspend in-flight network I/O
// with these error codes — they're recoverable: a re-issued request
// after the tab regains focus / network comes back will succeed.
// Permanent errors (HTTP 4xx, malformed JSON, etc.) keep their
// existing one-retry semantics so we don't mask real bugs.
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message || ''
  return /Failed to fetch|NetworkError|ERR_NETWORK_IO_SUSPENDED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Load failed/i.test(msg)
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Transient browser-side errors: retry 3 times with backoff.
      // Other errors: existing one-retry behaviour (catches a single
      // transient 5xx without masking real failures).
      retry: (failureCount, error) => {
        if (isTransientNetworkError(error)) return failureCount < 3
        return failureCount < 1
      },
      retryDelay: attempt => Math.min(1000 * 2 ** attempt, 8000),
      // Re-run on browser/window events. The workbench polls these on
      // an interval anyway, but re-firing immediately on focus/online
      // makes "you came back from sleep" feel instant rather than
      // waiting for the next polling tick.
      refetchOnReconnect: 'always',
      refetchOnWindowFocus: 'always',
      staleTime: 20_000,
    },
    mutations: {
      // Mutations don't auto-retry by default (re-issuing a POST is
      // unsafe in general), but transient *network* errors mean the
      // request never reached the server — retrying once is safe.
      retry: (failureCount, error) => {
        if (isTransientNetworkError(error)) return failureCount < 1
        return false
      },
      retryDelay: 1500,
    },
  },
})

// M69 Loop Theater — when the URL carries ?theater=<traceIdPrefix>, mount
// the theater instead of the regular workbench. Keeps the routing
// dependency-free (no react-router) and lets operators paste a link
// straight to a specific run's replay. trace_id from audit-gov looks
// like blueprint-<sessionId>-<stage>; the theater does a prefix match.
function bootstrap() {
  const params = new URLSearchParams(window.location.search)
  const theaterTrace = params.get('theater')
  if (theaterTrace) {
    return <LoopTheater traceIdPrefix={theaterTrace} standalone />
  }
  return <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {bootstrap()}
    </QueryClientProvider>
  </React.StrictMode>,
)
