/**
 * M42.6 — Bearer-token middleware for /api/codegen/*.
 *
 * Modes:
 *   - When `CODEGEN_SERVICE_TOKEN` is set to a non-default value, the
 *     middleware REQUIRES `Authorization: Bearer <token>` matching it
 *     on every request, returning 401 UNAUTHORIZED otherwise.
 *   - When `CODEGEN_SERVICE_TOKEN` is empty or the dev-default
 *     `dev-codegen-service-token`, the middleware accepts unauthenticated
 *     requests (the dev/docker-compose flow). The default value is
 *     considered a sentinel — production deployments MUST override it.
 *
 * The Foundry web SPA passes `Authorization: Bearer <token>` when
 * VITE_FOUNDRY_TOKEN is set; the CLI passes it via --token or
 * CODE_FOUNDRY_TOKEN env. The dev defaults keep local-compose flows
 * working out of the box.
 *
 * Localhost requests are also pass-through, regardless of token, so an
 * operator running the SPA against http://localhost:3005 from
 * http://localhost:5181 doesn't need to manage a token.
 */
import type { NextFunction, Request, Response } from 'express'
import { config } from '../config.js'

const DEV_DEFAULTS = new Set(['dev-codegen-service-token', 'changeme', ''])

function isProductionToken(): boolean {
  return !DEV_DEFAULTS.has(config.CODEGEN_SERVICE_TOKEN)
}

function isLocalhost(req: Request): boolean {
  // Express may receive the client's address via req.ip; the docker
  // bridge surfaces 127.0.0.1 / ::1 / ::ffff:127.0.0.1 for in-host
  // calls. We don't trust an X-Forwarded-For header to gate auth.
  const ip = req.ip ?? ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

export function requireBearer(_req: Request, _res: Response, _next: NextFunction): void {
  // delegate to the closure below — kept exported for type discovery
  return
}

export function bearerAuth() {
  return function check(req: Request, res: Response, next: NextFunction): void {
    if (!isProductionToken()) {
      // Dev / docker-compose default token in use; skip auth so the
      // operator running on localhost without env overrides isn't blocked.
      return next()
    }
    if (isLocalhost(req)) {
      return next()
    }
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing Bearer token.' })
      return
    }
    const token = header.slice('Bearer '.length).trim()
    if (token !== config.CODEGEN_SERVICE_TOKEN) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid Bearer token.' })
      return
    }
    next()
  }
}
