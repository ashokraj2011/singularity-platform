import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { signToken } from '../../lib/jwt'
import { validate } from '../../middleware/validate'
import { authMiddleware } from '../../middleware/auth'
import { config } from '../../config'

export const authRouter: Router = Router()

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

authRouter.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    if (config.AUTH_PROVIDER === 'iam') {
      res.status(400).json({
        code: 'IAM_AUTH_REQUIRED',
        message: 'Local Workgraph login is disabled while AUTH_PROVIDER=iam. Use Singularity IAM sign in.',
      })
      return
    }

    const { email, password } = req.body as z.infer<typeof loginSchema>

    const user = await prisma.user.findUnique({
      where: { email },
      include: { roles: { include: { role: true } }, skills: { include: { skill: true } } },
    })

    if (!user || !user.isActive || !user.passwordHash) {
      // Local password login is only valid when the user has a local hash —
      // IAM-only users (passwordHash null) must authenticate through IAM.
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid credentials' })
      return
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid credentials' })
      return
    }

    const token = await signToken({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
    })

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        teamId: user.teamId,
        roles: user.roles.map(ur => ({ id: ur.role.id, name: ur.role.name })),
      },
    })
  } catch (err) {
    next(err)
  }
})

authRouter.post('/iam-login', validate(loginSchema), async (req, res, next) => {
  try {
    if (!config.IAM_BASE_URL) {
      res.status(500).json({ code: 'CONFIG', message: 'IAM_BASE_URL is not set' })
      return
    }

    const upstream = await fetch(`${config.IAM_BASE_URL.replace(/\/$/, '')}/auth/local/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.body),
    })

    const text = await upstream.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      // Keep the raw upstream body for diagnostics below.
    }

    if (!upstream.ok) {
      const message =
        typeof body === 'object' && body && 'detail' in body
          ? String((body as { detail?: unknown }).detail)
          : typeof body === 'object' && body && 'message' in body
            ? String((body as { message?: unknown }).message)
            : 'IAM sign in failed'
      res.status(upstream.status).json({ code: 'IAM_LOGIN_FAILED', message })
      return
    }

    res.status(upstream.status).json(body)
  } catch (err) {
    next(err)
  }
})

authRouter.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: {
        team: true,
        roles: { include: { role: true } },
        skills: { include: { skill: true } },
      },
    })
    if (!user) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' })
      return
    }
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isActive: user.isActive,
      teamId: user.teamId,
      teamName: user.team?.name,
      roles: user.roles.map(ur => ({ id: ur.role.id, name: ur.role.name })),
      skills: user.skills.map(us => ({
        id: us.skill.id,
        name: us.skill.name,
        proficiencyLevel: us.proficiencyLevel,
      })),
    })
  } catch (err) {
    next(err)
  }
})
