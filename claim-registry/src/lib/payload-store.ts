/**
 * Raw-capture payload store. Production backs payloadRef with MinIO (bounded,
 * fail-closed fetch). M-CR2 stub: small captures are stored INLINE in the ref
 * (base64) so the lowering pass can read them back without MinIO wired yet.
 */
export function putPayload(content: string): string {
  // TODO(M-CR2 hardening): if MINIO_ENDPOINT is set, upload and return a minio:// ref.
  return 'inline:' + Buffer.from(content, 'utf8').toString('base64');
}

export function getPayload(ref: string): string {
  if (ref.startsWith('inline:')) return Buffer.from(ref.slice(7), 'base64').toString('utf8');
  throw new Error('non-inline payload fetch (MinIO) is not wired in M-CR2');
}
