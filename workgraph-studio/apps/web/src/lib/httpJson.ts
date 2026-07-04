export async function readJsonResponse<T>(response: Response, label = 'response'): Promise<T> {
  const text = await response.text().catch(() => '')
  const body = text.trim()
  if (!body) return undefined as T

  try {
    return JSON.parse(body) as T
  } catch {
    const preview = body.replace(/\s+/g, ' ').slice(0, 160)
    throw new Error(`${label} returned non-JSON response${preview ? `: ${preview}` : ''}`)
  }
}

export function responseEvents<T>(value: unknown): T[] {
  if (value && typeof value === 'object' && Array.isArray((value as { events?: unknown }).events)) {
    return (value as { events: T[] }).events
  }
  return []
}

export function responseTailId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = (value as { tail_id?: unknown }).tail_id
  return typeof raw === 'string' && raw ? raw : undefined
}
