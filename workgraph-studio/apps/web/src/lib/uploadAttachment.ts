import { api } from './api'

export type AttachmentKind = 'UPLOAD' | 'LINK'

export type UploadedDocument = {
  id:         string
  kind?:      AttachmentKind
  name:       string
  mimeType?:  string | null
  sizeBytes?: number | null
  url?:       string | null
  provider?:  string | null
  taskId:     string | null
  nodeId:     string | null
  instanceId: string | null
  uploadedAt: string
  downloadUrl?: string
}

/**
 * Upload a file to /api/documents/upload.  The optional task/node/instance ids
 * are stored on the resulting Document row so attachments can be queried back
 * by the consumer of the runtime form (e.g. for reviewing a submitted task).
 */
export async function uploadAttachment(
  file: File,
  link: { taskId?: string; nodeId?: string; instanceId?: string } = {},
): Promise<UploadedDocument> {
  const form = new FormData()
  form.append('file', file)
  if (link.taskId)     form.append('taskId',     link.taskId)
  if (link.nodeId)     form.append('nodeId',     link.nodeId)
  if (link.instanceId) form.append('instanceId', link.instanceId)

  const res = await api.post('/documents/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data as UploadedDocument
}

/**
 * Attach an external URL (OneDrive, SharePoint, Drive, S3, etc.).  No size
 * limit — the file lives at the destination.  The provider is auto-detected
 * server-side from the URL host but can be overridden.
 */
export async function attachLink(
  url: string,
  opts: { name?: string; provider?: string; taskId?: string; nodeId?: string; instanceId?: string } = {},
): Promise<UploadedDocument> {
  const res = await api.post('/documents/links', {
    url,
    ...(opts.name      ? { name: opts.name }      : {}),
    ...(opts.provider  ? { provider: opts.provider } : {}),
    ...(opts.taskId    ? { taskId: opts.taskId }    : {}),
    ...(opts.nodeId    ? { nodeId: opts.nodeId }    : {}),
    ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
  })
  return res.data as UploadedDocument
}
