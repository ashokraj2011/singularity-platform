/**
 * M42.6 — Bearer-token middleware for /api/codegen/*.
 *
 * Modes:
 *   - When `CODEGEN_SERVICE_TOKEN` is set to a non-default value, the
 *     middleware REQUIRES `Authorization: Bearer <token>` matching it
 *     on every request, returning 401 UNAUTHORIZED otherwise.
 *   - When `CODEGEN_SERVICE_TOKEN` is empty or the dev-default
 *     `dev-codegen-service-token`, only localhost requests may skip auth.
 *     Non-local requests must still present the configured bearer.
 *
 * The Foundry web SPA passes `Authorization: Bearer <token>` when
 * VITE_FOUNDRY_TOKEN is set; the CLI passes it via --token or
 * CODE_FOUNDRY_TOKEN env. The dev defaults keep local-compose flows
 * working out of the box.
 *
 * Localhost requests are pass-through only for the dev-default token, so an
 * operator running a local SPA can iterate without credentials while exposed
 * host/office-box traffic cannot ride the default into an open API.
 */
import type { NextFunction, Request, Response } from 'express'
import { config, isProductionClassEnv } from '../config.js'

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
    if (!isProductionToken() && !isProductionClassEnv() && isLocalhost(req)) {
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
