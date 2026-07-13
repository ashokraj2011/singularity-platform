/**
 * GitHub webhook receiver (spec §7 automation). Public — mounted OUTSIDE authMiddleware like the
 * triggers webhook — and gated by the GitHub delivery signature (HMAC over the raw body with
 * GITHUB_WEBHOOK_SECRET), not a bearer. A pull_request event auto-registers an implementation
 * submission against the matching Work Item's published handoff.
 */
import { Router, type Request } from 'express'
import { verifyGithubSignature } from './github-webhook'
import { handleGithubPullRequest } from './github-webhook.service'

export const githubWebhookRouter: Router = Router()

type RawBodyRequest = Request & { rawBody?: Buffer }

githubWebhookRouter.post('/', async (req, res, next) => {
  try {
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? ''
    if (!secret) return res.status(503).json({ error: 'GitHub webhook is not configured (GITHUB_WEBHOOK_SECRET is unset).' })

    const rawBody = (req as RawBodyRequest).rawBody
    const signature = req.header('x-hub-signature-256')
    if (!rawBody || !verifyGithubSignature(rawBody, signature, secret)) {
      return res.status(401).json({ error: 'Invalid or missing webhook signature.' })
    }

    const event = req.header('x-github-event')
    if (event === 'ping') return res.json({ ok: true })
    if (event !== 'pull_request') return res.json({ status: 'ignored', detail: `event '${event ?? 'unknown'}' not handled` })

    const result = await handleGithubPullRequest(req.body)
    res.status(result.status === 'registered' ? 201 : 200).json(result)
  } catch (err) { next(err) }
})
