import type { RequestHandler } from 'express'
import type { ZodSchema } from 'zod'

export function validate(schema: ZodSchema): RequestHandler {
  return (req, _res, next) => {
    req.body = schema.parse(req.body)
    next()
  }
}

export function validateQuery(schema: ZodSchema): RequestHandler {
  return (req, _res, next) => {
    req.query = schema.parse(req.query) as typeof req.query
    next()
  }
}
