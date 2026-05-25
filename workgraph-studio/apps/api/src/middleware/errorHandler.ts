import type { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import { AppError } from '../lib/errors'

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: err.flatten().fieldErrors,
    })
    return
  }

  if (err instanceof AppError) {
    // M78 — Pass structured `details` through to clients when present.
    // Used by the inherited-failure analyzer to send actionable cards
    // instead of a string the workbench has to parse.
    const body: Record<string, unknown> = { code: err.code, message: err.message }
    if (err.details && typeof err.details === 'object') {
      body.details = err.details
    }
    res.status(err.statusCode).json(body)
    return
  }

  console.error('Unhandled error:', err)
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
}
