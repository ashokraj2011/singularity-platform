/** Pull a human-readable message out of an axios error (or any thrown value). */
export function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'response' in e) {
    const data = (e as { response?: { data?: unknown } }).response?.data as
      | { error?: { message?: string } | string; message?: string }
      | string
      | undefined
    if (typeof data === 'string' && data) return data
    if (data && typeof data === 'object') {
      if (typeof data.error === 'object' && data.error?.message) return data.error.message
      if (typeof data.error === 'string' && data.error) return data.error
      if (data.message) return data.message
    }
  }
  if (e instanceof Error) return e.message
  return 'Request failed'
}
