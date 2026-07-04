import { useMemo, useSyncExternalStore } from 'react'

const NAVIGATION_EVENT = 'singularity:vite-navigation'

type RouterOptions = { scroll?: boolean }

function currentHref(): string {
  return typeof window === 'undefined' ? '' : window.location.href
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('popstate', callback)
  window.addEventListener(NAVIGATION_EVENT, callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener(NAVIGATION_EVENT, callback)
  }
}

function emitNavigationChange() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(NAVIGATION_EVENT))
}

function navigate(to: string, replace = false) {
  if (typeof window === 'undefined') return
  if (replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  emitNavigationChange()
}

function pathSegments(): string[] {
  if (typeof window === 'undefined') return []
  return window.location.pathname.split('/').filter(Boolean)
}

function useLocationHref(): string {
  return useSyncExternalStore(subscribe, currentHref, () => '')
}

export function useRouter() {
  return useMemo(() => ({
    push: (href: string, _options?: RouterOptions) => navigate(href),
    replace: (href: string, _options?: RouterOptions) => navigate(href, true),
    back: () => {
      if (typeof window !== 'undefined') window.history.back()
    },
    forward: () => {
      if (typeof window !== 'undefined') window.history.forward()
    },
    refresh: () => emitNavigationChange(),
    prefetch: (_href: string) => Promise.resolve(),
  }), [])
}

export function usePathname(): string {
  useLocationHref()
  return typeof window === 'undefined' ? '/' : window.location.pathname
}

export function useSearchParams(): URLSearchParams {
  const href = useLocationHref()
  return useMemo(() => {
    if (typeof window === 'undefined') return new URLSearchParams()
    return new URLSearchParams(window.location.search)
  }, [href])
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T {
  const href = useLocationHref()
  return useMemo(() => {
    const segments = pathSegments()
    const params: Record<string, string | undefined> = {}
    const last = segments.at(-1)
    const beforeLast = segments.at(-2)

    if (last) {
      params.id = decodeURIComponent(last)
      params.runId = decodeURIComponent(last)
    }
    if (beforeLast) params.kind = decodeURIComponent(beforeLast)

    const designIndex = segments.indexOf('design')
    if (designIndex >= 0 && segments[designIndex + 1]) {
      params.workflowId = decodeURIComponent(segments[designIndex + 1])
    }
    const workflowIndex = segments.indexOf('workflow')
    if (workflowIndex >= 0 && segments[workflowIndex + 1]) {
      params.instanceId = decodeURIComponent(segments[workflowIndex + 1])
    }
    const playIndex = segments.indexOf('play')
    if (playIndex >= 0 && segments[playIndex + 1]) {
      params.runId = decodeURIComponent(segments[playIndex + 1])
    }

    return params as T
  }, [href])
}

export function redirect(href: string): never {
  navigate(href, true)
  throw new Error(`redirected to ${href}`)
}

export function notFound(): never {
  throw new Error('notFound')
}
