import type { PageResponse } from '@workgraph/shared-types'

export interface PaginationParams {
  page: number
  size: number
  skip: number
  take: number
}

export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const page = Math.max(0, Number(query.page) || 0)
  const size = Math.min(100, Math.max(1, Number(query.size) || 20))
  return { page, size, skip: page * size, take: size }
}

export function toPageResponse<T>(
  content: T[],
  total: number,
  { page, size }: PaginationParams,
): PageResponse<T> {
  return {
    content,
    page,
    size,
    totalElements: total,
    totalPages: Math.ceil(total / size),
  }
}
