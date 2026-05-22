import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { LoopTheater } from './loop-theater/LoopTheater'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 20_000 },
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
