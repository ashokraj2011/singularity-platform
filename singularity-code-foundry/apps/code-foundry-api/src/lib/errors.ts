/**
 * M42.1 — Domain error classes.
 *
 * The express error handler maps these to status codes; the CLI maps them
 * to exit codes. FeatureDisabledError comes from the shared feature-flags
 * package so the REST middleware and the CLI gate produce identical
 * payloads.
 */

export class AppError extends Error {
  public readonly status: number
  public readonly code: string
  public readonly details?: Record<string, unknown>

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, 'VALIDATION_ERROR', message, details)
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(404, 'NOT_FOUND', `${entity} ${id} not found`)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, 'CONFLICT', message, details)
    this.name = 'ConflictError'
  }
}
