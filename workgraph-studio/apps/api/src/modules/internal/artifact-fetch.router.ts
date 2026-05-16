import { Router, type Request } from 'express'
import { z } from 'zod'
import { config } from '../../config'
import { prisma } from '../../lib/prisma'
import { minioClient } from '../../lib/minio'
import { NotFoundError, ValidationError } from '../../lib/errors'

export const internalArtifactFetchRouter: Router = Router()

const MAX_BYTES = Number(process.env.INTERNAL_ARTIFACT_FETCH_MAX_BYTES ?? 64_000)

const fetchSchema = z.object({
  minioRef: z.string().optional(),
  documentId: z.string().optional(),
  maxBytes: z.number().int().positive().max(256_000).optional(),
})

function hasServiceToken(req: Request): boolean {
  const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined
  const header = typeof req.headers['x-service-token'] === 'string' ? req.headers['x-service-token'] : undefined
  return (bearer ?? header) === config.WORKGRAPH_INTERNAL_TOKEN
}

function parseObjectRef(ref: string): { bucket: string; key: string; documentId?: string } {
  const trimmed = ref.trim()
  if (!trimmed) throw new ValidationError('Artifact reference is empty')
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return { bucket: config.MINIO_BUCKET, key: '', documentId: trimmed }
  }
  if (trimmed.startsWith('document:')) {
    return { bucket: config.MINIO_BUCKET, key: '', documentId: trimmed.slice('document:'.length) }
  }
  if (trimmed.startsWith('workgraph-document://')) {
    return { bucket: config.MINIO_BUCKET, key: '', documentId: trimmed.slice('workgraph-document://'.length) }
  }
  if (trimmed.startsWith('minio://') || trimmed.startsWith('s3://')) {
    const url = new URL(trimmed)
    const bucket = url.hostname
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!bucket || !key) throw new ValidationError(`Invalid object reference: ${ref}`)
    return { bucket, key }
  }
  const slash = trimmed.indexOf('/')
  if (slash > 0) return { bucket: trimmed.slice(0, slash), key: trimmed.slice(slash + 1) }
  throw new ValidationError(`Unsupported artifact reference: ${ref}`)
}

function isTextMediaType(mediaType?: string | null): boolean {
  if (!mediaType) return true
  const lower = mediaType.toLowerCase()
  return lower.startsWith('text/') ||
    lower.includes('json') ||
    lower.includes('xml') ||
    lower.includes('yaml') ||
    lower.includes('markdown') ||
    lower.includes('csv')
}

async function readObject(bucket: string, key: string, maxBytes: number): Promise<{ content: string; bytes: number; truncated: boolean }> {
  const stream = await minioClient.getObject(bucket, key)
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remaining = maxBytes - total
    if (remaining <= 0) {
      truncated = true
      break
    }
    chunks.push(buffer.subarray(0, remaining))
    total += Math.min(buffer.length, remaining)
    if (buffer.length > remaining) {
      truncated = true
      break
    }
  }
  return { content: Buffer.concat(chunks).toString('utf8'), bytes: total, truncated }
}

internalArtifactFetchRouter.post('/fetch', async (req, res, next) => {
  try {
    if (!hasServiceToken(req)) {
      return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid artifact fetch service token' })
    }
    const body = fetchSchema.parse(req.body ?? {})
    const maxBytes = Math.min(body.maxBytes ?? MAX_BYTES, MAX_BYTES)
    let bucket = config.MINIO_BUCKET
    let key = ''
    let mediaType: string | null | undefined
    let source = body.minioRef ?? ''

    const documentId = body.documentId ?? (body.minioRef ? parseObjectRef(body.minioRef).documentId : undefined)
    if (documentId) {
      const doc = await prisma.document.findUnique({ where: { id: documentId } })
      if (!doc) throw new NotFoundError('Document', documentId)
      if (doc.kind === 'LINK') throw new ValidationError('Linked documents are not fetched server-side; pass an excerpt or governed upload.')
      if (!doc.bucket || !doc.storageKey) throw new ValidationError('Document has no MinIO object reference')
      if (!isTextMediaType(doc.mimeType)) throw new ValidationError(`Document ${doc.id} is not text-like (${doc.mimeType ?? 'unknown'})`)
      bucket = doc.bucket
      key = doc.storageKey
      mediaType = doc.mimeType
      source = `document:${doc.id}`
    } else if (body.minioRef) {
      const parsed = parseObjectRef(body.minioRef)
      bucket = parsed.bucket
      key = parsed.key
    } else {
      throw new ValidationError('minioRef or documentId is required')
    }

    const object = await readObject(bucket, key, maxBytes)
    res.json({
      source,
      bucket,
      key,
      mediaType,
      content: object.content,
      bytes: object.bytes,
      truncated: object.truncated,
    })
  } catch (err) {
    next(err)
  }
})
