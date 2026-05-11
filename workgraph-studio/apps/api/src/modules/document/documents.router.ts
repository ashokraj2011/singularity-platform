import { Router } from 'express'
import multer from 'multer'
import { randomUUID } from 'crypto'
import { prisma } from '../../lib/prisma'
import { minioClient } from '../../lib/minio'
import { config } from '../../config'
import { NotFoundError, ForbiddenError } from '../../lib/errors'
import { logEvent } from '../../lib/audit'

export const documentsRouter: Router = Router()

// Server-side cap for *uploaded* files.  Anything larger should be attached as
// a LINK (OneDrive / SharePoint / Drive / S3 link) — the link endpoint has no
// size limit.  Default 1 GB, override via env.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 1024 * 1024 * 1024)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } })

// Auto-detect the link provider from a URL host so the UI can render the
// right icon without the operator having to pick.
function detectProvider(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('sharepoint.com'))                          return 'SHAREPOINT'
    if (host.includes('1drv.ms') || host.includes('onedrive.live')) return 'ONEDRIVE'
    if (host.includes('docs.google.com') || host.includes('drive.google.com')) return 'GDRIVE'
    if (host.includes('dropbox.com'))                             return 'DROPBOX'
    if (host.includes('box.com'))                                 return 'BOX'
    if (host.includes('s3.amazonaws.com') || host.endsWith('.s3') || host.endsWith('.s3.amazonaws.com')) return 'S3'
    if (host.includes('github.com'))                              return 'GITHUB'
    return 'GENERIC'
  } catch {
    return 'GENERIC'
  }
}

const ADMIN_ROLE_NAMES = ['ADMIN', 'admin', 'Admin', 'SYSTEM_ADMIN', 'SystemAdmin', 'WORKFLOW_ADMIN', 'WorkflowAdmin']

async function isUserAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { roles: { include: { role: { select: { name: true } } } } },
  })
  if (!user) return false
  return user.roles.some(ur => ADMIN_ROLE_NAMES.includes(ur.role.name))
}

// ─── List ─────────────────────────────────────────────────────────────────────

documentsRouter.get('/', async (req, res, next) => {
  try {
    const { taskId, nodeId, instanceId } = req.query as Record<string, string>
    const docs = await prisma.document.findMany({
      where: {
        ...(taskId     ? { taskId }     : {}),
        ...(nodeId     ? { nodeId }     : {}),
        ...(instanceId ? { instanceId } : {}),
      },
      orderBy: { uploadedAt: 'desc' },
    })
    res.json(docs.map(d => ({
      ...d,
      sizeBytes: d.sizeBytes !== null ? Number(d.sizeBytes) : null,
      // For LINK rows, expose the URL as `downloadUrl` for symmetry with UPLOAD.
      downloadUrl: d.kind === 'LINK' ? d.url : undefined,
    })))
  } catch (err) { next(err) }
})

// ─── Get one (metadata + presigned URL) ───────────────────────────────────────

documentsRouter.get('/:id', async (req, res, next) => {
  try {
    const doc = await prisma.document.findUnique({ where: { id: req.params.id } })
    if (!doc) throw new NotFoundError('Document', req.params.id)

    let downloadUrl: string | undefined
    if (doc.kind === 'LINK') {
      downloadUrl = doc.url ?? undefined
    } else if (doc.bucket && doc.storageKey) {
      try {
        downloadUrl = await minioClient.presignedGetObject(doc.bucket, doc.storageKey, 3600)
      } catch (err) {
        // Bucket / key may not exist if attachment was deleted out-of-band; ignore
        console.error('Failed to generate presigned URL:', err)
      }
    }

    res.json({
      ...doc,
      sizeBytes: doc.sizeBytes !== null ? Number(doc.sizeBytes) : null,
      downloadUrl,
    })
  } catch (err) { next(err) }
})

// ─── Upload ───────────────────────────────────────────────────────────────────

documentsRouter.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' })
      return
    }

    const { taskId, nodeId, instanceId } = req.body as { taskId?: string; nodeId?: string; instanceId?: string }

    // Permission check: if a taskId is supplied, ensure the user is assigned to it
    if (taskId) {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: { assignments: true },
      })
      if (!task) throw new NotFoundError('Task', taskId)
      const isAssigned = task.assignments.some(a => a.assignedToId === req.user!.userId)
      const isCreator = task.createdById === req.user!.userId
      const isAdmin = !isAssigned && !isCreator ? await isUserAdmin(req.user!.userId) : false
      if (!isAssigned && !isAdmin && !isCreator) {
        throw new ForbiddenError('Not allowed to upload attachments to this task')
      }
    }

    // Build a unique storage key.  Bucket comes from config.
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storageKey = `${taskId ?? nodeId ?? 'general'}/${randomUUID()}-${safeName}`
    const bucket = config.MINIO_BUCKET

    await minioClient.putObject(bucket, storageKey, file.buffer, file.size, {
      'Content-Type': file.mimetype,
    })

    // Browser-driven /play sessions pass design-time WorkflowDesignNode ids
    // and IndexedDB-local run ids, neither of which exist as rows in
    // WorkflowNode / WorkflowInstance. Drop the link to null when the FK
    // target is missing so the upload still succeeds — the audit log below
    // keeps the originally-supplied ids for traceability.
    const [nodeExists, instanceExists] = await Promise.all([
      nodeId     ? prisma.workflowNode.findUnique({ where: { id: nodeId }, select: { id: true } })     : Promise.resolve(null),
      instanceId ? prisma.workflowInstance.findUnique({ where: { id: instanceId }, select: { id: true } }) : Promise.resolve(null),
    ])
    const resolvedNodeId     = nodeExists     ? nodeId     : null
    const resolvedInstanceId = instanceExists ? instanceId : null

    const doc = await prisma.document.create({
      data: {
        kind:         'UPLOAD',
        name:         file.originalname,
        mimeType:     file.mimetype,
        sizeBytes:    BigInt(file.size),
        storageKey,
        bucket,
        uploadedById: req.user!.userId,
        taskId:       taskId ?? null,
        nodeId:       resolvedNodeId,
        instanceId:   resolvedInstanceId,
      },
    })

    await logEvent('DocumentUploaded', 'Document', doc.id, req.user!.userId, {
      taskId: taskId ?? null,
      nodeId: nodeId ?? null,
      instanceId: instanceId ?? null,
      sizeBytes: file.size,
      mimeType: file.mimetype,
    })

    let downloadUrl: string | undefined
    try {
      downloadUrl = await minioClient.presignedGetObject(bucket, storageKey, 3600)
    } catch { /* ignore */ }

    res.status(201).json({
      id:         doc.id,
      kind:       doc.kind,
      name:       doc.name,
      mimeType:   doc.mimeType,
      sizeBytes:  doc.sizeBytes !== null ? Number(doc.sizeBytes) : null,
      taskId:     doc.taskId,
      nodeId:     doc.nodeId,
      instanceId: doc.instanceId,
      uploadedAt: doc.uploadedAt,
      downloadUrl,
    })
  } catch (err) { next(err) }
})

// ─── Attach a link (no upload) ────────────────────────────────────────────────
//
// Used for OneDrive / SharePoint / Drive / Dropbox / arbitrary HTTPS URLs.
// No size limit — the file lives elsewhere; we only store the pointer.
documentsRouter.post('/links', async (req, res, next) => {
  try {
    const { url, name, provider, taskId, nodeId, instanceId, label } = req.body as {
      url?: string; name?: string; provider?: string;
      taskId?: string; nodeId?: string; instanceId?: string; label?: string;
    }
    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      res.status(400).json({ error: 'url is required' }); return
    }
    let parsed: URL
    try { parsed = new URL(url) } catch { res.status(400).json({ error: 'url must be a valid URL' }); return }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      res.status(400).json({ error: 'Only http(s) URLs are accepted' }); return
    }

    if (taskId) {
      const task = await prisma.task.findUnique({ where: { id: taskId }, include: { assignments: true } })
      if (!task) throw new NotFoundError('Task', taskId)
      const isAssigned = task.assignments.some(a => a.assignedToId === req.user!.userId)
      const isCreator  = task.createdById === req.user!.userId
      const isAdmin    = !isAssigned && !isCreator ? await isUserAdmin(req.user!.userId) : false
      if (!isAssigned && !isAdmin && !isCreator) {
        throw new ForbiddenError('Not allowed to attach links to this task')
      }
    }

    const finalProvider = provider || detectProvider(url)
    const finalName = (name || label || parsed.pathname.split('/').pop() || parsed.hostname).slice(0, 200)

    const doc = await prisma.document.create({
      data: {
        kind:         'LINK',
        name:         finalName,
        url,
        provider:     finalProvider,
        uploadedById: req.user!.userId,
        taskId:       taskId ?? null,
        nodeId:       nodeId ?? null,
        instanceId:   instanceId ?? null,
      },
    })

    await logEvent('DocumentLinkAttached', 'Document', doc.id, req.user!.userId, {
      taskId: taskId ?? null, nodeId: nodeId ?? null, instanceId: instanceId ?? null,
      provider: finalProvider, host: parsed.hostname,
    })

    res.status(201).json({
      id:          doc.id,
      name:        doc.name,
      kind:        doc.kind,
      provider:    doc.provider,
      url:         doc.url,
      taskId:      doc.taskId,
      nodeId:      doc.nodeId,
      instanceId:  doc.instanceId,
      uploadedAt:  doc.uploadedAt,
      downloadUrl: doc.url,
    })
  } catch (err) { next(err) }
})

// ─── Delete ───────────────────────────────────────────────────────────────────

documentsRouter.delete('/:id', async (req, res, next) => {
  try {
    const doc = await prisma.document.findUnique({ where: { id: req.params.id } })
    if (!doc) throw new NotFoundError('Document', req.params.id)

    // Only uploader or admin may delete
    const isOwner = doc.uploadedById === req.user!.userId
    const isAdmin = !isOwner ? await isUserAdmin(req.user!.userId) : false
    if (!isAdmin && !isOwner) throw new ForbiddenError('Only the uploader or an admin can delete this document')

    if (doc.kind === 'UPLOAD' && doc.bucket && doc.storageKey) {
      try {
        await minioClient.removeObject(doc.bucket, doc.storageKey)
      } catch (err) {
        console.error('Failed to remove S3 object (continuing with DB delete):', err)
      }
    }
    await prisma.document.delete({ where: { id: req.params.id } })

    await logEvent('DocumentDeleted', 'Document', req.params.id, req.user!.userId)

    res.status(204).send()
  } catch (err) { next(err) }
})
