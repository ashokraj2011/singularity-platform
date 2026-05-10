/**
 * Notify router — thin templating + dispatcher on top of the existing
 * connector adapters (EmailAdapter / TeamsAdapter).
 *
 *   POST /api/notify/email   { to, subject, body, html?, cc?, bcc?, context?, connectorId? }
 *   POST /api/notify/teams   { message, html?, webhookUrl?, context?, connectorId? }
 *
 * Each endpoint:
 *   1) Resolves a connector — explicit `connectorId`, or falls back to the
 *      single ACTIVE connector of the target type ('EMAIL' / 'TEAMS').
 *   2) Substitutes `{{vars.X}}`, `{{globals.X}}`, `{{output.X}}`, `{{run.X}}`
 *      tokens in the body / subject against the supplied `context` so the
 *      browser runtime can hand off its live RunState.context for templating.
 *   3) Calls adapter.invoke('sendEmail' | 'postWebhook' | 'postChannelMessage')
 *      and returns the result.
 *
 * Outbound delivery is fire-and-forward — if the adapter throws, the caller
 * gets a 502 with the underlying error.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { logEvent } from '../../lib/audit'
import { buildAdapter } from '../connectors/connector.service'

export const notifyRouter: Router = Router()

// ── Templating ───────────────────────────────────────────────────────────────
//
// Lightweight `{{path}}` substitution.  The path resolver mirrors the runtime
// EdgeEvaluator so notify tokens follow the same vocabulary the workflow
// itself uses.

function walk(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function resolve(ctx: Record<string, unknown>, path: string): unknown {
  if (path.startsWith('globals.')) return walk(ctx._globals as Record<string, unknown>, path.slice('globals.'.length))
  if (path.startsWith('vars.'))    return walk(ctx._vars    as Record<string, unknown>, path.slice('vars.'.length))
  if (path.startsWith('params.'))  return walk(ctx._params  as Record<string, unknown>, path.slice('params.'.length))
  if (path.startsWith('output.'))  return walk(ctx,  path.slice('output.'.length))
  if (path.startsWith('context.')) return walk(ctx,  path.slice('context.'.length))
  if (path.startsWith('run.'))     return walk(ctx._run as Record<string, unknown>, path.slice('run.'.length))
  return walk(ctx, path)
}

function template(input: string | undefined, context: Record<string, unknown>): string | undefined {
  if (!input) return input
  return input.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, path) => {
    const v = resolve(context, String(path))
    if (v === undefined || v === null) return ''
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  })
}

// ── Connector resolution ─────────────────────────────────────────────────────

async function pickConnector(type: 'EMAIL' | 'TEAMS', explicitId?: string) {
  if (explicitId) {
    const c = await prisma.connector.findUnique({ where: { id: explicitId } })
    if (!c) throw Object.assign(new Error(`Connector ${explicitId} not found`), { status: 404 })
    if (c.archivedAt) throw Object.assign(new Error(`Connector ${explicitId} is archived`), { status: 400 })
    if (c.type !== type) throw Object.assign(new Error(`Connector ${explicitId} is type ${c.type}, expected ${type}`), { status: 400 })
    return c
  }
  const candidates = await prisma.connector.findMany({
    where: { type, archivedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: 2,
  })
  if (candidates.length === 0) {
    throw Object.assign(new Error(`No active ${type} connector configured`), { status: 412 })
  }
  // Multiple? Pick the most-recently-updated one and warn via audit.
  return candidates[0]
}

// ── Endpoints ────────────────────────────────────────────────────────────────

const emailSchema = z.object({
  to:           z.union([z.string().min(3), z.array(z.string().min(3))]),
  subject:      z.string().min(1),
  body:         z.string().optional(),
  html:         z.string().optional(),
  cc:           z.union([z.string(), z.array(z.string())]).optional(),
  bcc:          z.union([z.string(), z.array(z.string())]).optional(),
  context:      z.record(z.unknown()).optional(),
  connectorId:  z.string().optional(),
})

notifyRouter.post('/email', async (req: Request, res: Response) => {
  const parsed = emailSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload', details: parsed.error.format() })
  const { to, subject, body, html, cc, bcc, context = {}, connectorId } = parsed.data
  const userId = (req as any).user?.userId as string | undefined

  try {
    const connector = await pickConnector('EMAIL', connectorId)
    const adapter   = buildAdapter(connector.type, connector.config as any, connector.credentials as any)

    const ctx = context as Record<string, unknown>
    const result = await adapter.invoke('sendEmail', {
      to,
      cc, bcc,
      subject: template(subject, ctx) ?? subject,
      text:    template(body, ctx),
      html:    template(html, ctx),
    })

    await logEvent('NotifyEmailSent', 'Connector', connector.id, userId, {
      to: Array.isArray(to) ? to : [to],
      subject,
    })
    return res.json({ ok: true, result })
  } catch (err: any) {
    const status = err?.status ?? 502
    return res.status(status).json({ error: err?.message ?? 'Email send failed' })
  }
})

const teamsSchema = z.object({
  message:      z.string().optional(),
  html:         z.string().optional(),
  webhookUrl:   z.string().url().optional(),
  card:         z.unknown().optional(),
  channelId:    z.string().optional(),
  teamId:       z.string().optional(),
  context:      z.record(z.unknown()).optional(),
  connectorId:  z.string().optional(),
})

notifyRouter.post('/teams', async (req: Request, res: Response) => {
  const parsed = teamsSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload', details: parsed.error.format() })
  const { message, html, webhookUrl, card, channelId, teamId, context = {}, connectorId } = parsed.data
  const userId = (req as any).user?.userId as string | undefined

  try {
    const connector = await pickConnector('TEAMS', connectorId)
    const adapter   = buildAdapter(connector.type, connector.config as any, connector.credentials as any)
    const ctx = context as Record<string, unknown>

    let operation: string = 'postWebhook'
    let params: Record<string, unknown> = {
      text: template(message, ctx),
      webhookUrl,
    }
    if (card) {
      operation = 'postAdaptiveCard'
      params = { card, webhookUrl }
    } else if (teamId && channelId) {
      operation = 'postChannelMessage'
      params = { text: template(message, ctx), html: template(html, ctx), teamId, channelId }
    }

    const result = await adapter.invoke(operation, params)
    await logEvent('NotifyTeamsSent', 'Connector', connector.id, userId, { operation })
    return res.json({ ok: true, operation, result })
  } catch (err: any) {
    const status = err?.status ?? 502
    return res.status(status).json({ error: err?.message ?? 'Teams send failed' })
  }
})

// ── Discovery: which channels are available? ────────────────────────────────
//
// Lets the UI light up Email / Teams buttons only when there's something to
// dispatch through.  Returns just type + id + name; never the credentials.
notifyRouter.get('/channels', async (_req, res) => {
  const rows = await prisma.connector.findMany({
    where: { archivedAt: null, type: { in: ['EMAIL', 'TEAMS'] } },
    select: { id: true, type: true, name: true, description: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  })
  res.json(rows)
})
