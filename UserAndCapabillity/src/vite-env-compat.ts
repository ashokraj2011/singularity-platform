export const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

export const IDENTITY_BASE = viteEnv.BASE_URL ?? '/identity/'

export function identityPath(path: string): string {
  const prefix = IDENTITY_BASE.replace(/\/$/, '')
  return `${prefix}${path.startsWith('/') ? path : `/${path}`}`
}
