import { createRoot } from 'react-dom/client'

const links = [
  { href: '/workflows', label: 'Workflows' },
  { href: '/workflows/planner', label: 'Planner' },
  { href: '/runs', label: 'Runs' },
]

function StandaloneWorkgraphEntry() {
  return (
    <main style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      background: '#f6f8fb',
      color: '#102033',
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      padding: 24,
    }}>
      <section style={{
        width: 'min(760px, 100%)',
        border: '1px solid #d8e0ea',
        borderRadius: 18,
        background: '#ffffff',
        boxShadow: '0 20px 60px rgba(16, 32, 51, 0.12)',
        padding: 32,
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.4, color: '#0f8a4c', textTransform: 'uppercase' }}>
          Unified Platform Route
        </div>
        <h1 style={{ margin: '12px 0 10px', fontSize: 34, lineHeight: 1.05 }}>
          Workgraph is hosted by Platform Web
        </h1>
        <p style={{ margin: 0, color: '#536579', fontSize: 16, lineHeight: 1.65 }}>
          The standalone Workgraph shell remains buildable for compatibility, but the active user experience
          lives in the unified Singularity platform app.
        </p>
        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 26 }}>
          {links.map(link => (
            <a
              key={link.href}
              href={link.href}
              style={{
                border: '1px solid #cbd6e2',
                borderRadius: 12,
                color: '#102033',
                fontWeight: 750,
                padding: '10px 14px',
                textDecoration: 'none',
                background: '#f8fafc',
              }}
            >
              {link.label}
            </a>
          ))}
        </nav>
      </section>
    </main>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<StandaloneWorkgraphEntry />)
