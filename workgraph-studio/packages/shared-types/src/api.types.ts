export interface PageResponse<T> {
  content: T[]
  page: number
  size: number
  totalElements: number
  totalPages: number
}

export interface ErrorResponse {
  code: string
  message: string
  details?: Record<string, string[]>
}

export interface ApiResponse<T> {
  data: T
  message?: string
}
