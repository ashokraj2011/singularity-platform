export const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

export const WORKBENCH_BASE = viteEnv.BASE_URL ?? '/workbench/'

export function workbenchPath(path: string): string {
  const prefix = WORKBENCH_BASE.replace(/\/$/, '')
  return `${prefix}${path.startsWith('/') ? path : `/${path}`}`
}
