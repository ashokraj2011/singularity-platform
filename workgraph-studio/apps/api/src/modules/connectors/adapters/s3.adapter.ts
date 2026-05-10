import { Client as MinioClient } from 'minio'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface S3Config { bucket: string; region?: string; endpointUrl?: string }
interface S3Credentials { accessKeyId: string; secretAccessKey: string }

export class S3Adapter implements ConnectorAdapter {
  private minio: MinioClient

  constructor(private config: S3Config, private creds: S3Credentials) {
    const endpointUrl = config.endpointUrl ? new URL(config.endpointUrl) : null
    this.minio = new MinioClient({
      endPoint: endpointUrl?.hostname ?? 's3.amazonaws.com',
      port: endpointUrl ? parseInt(endpointUrl.port || '443') : 443,
      useSSL: endpointUrl ? endpointUrl.protocol === 'https:' : true,
      region: config.region ?? 'us-east-1',
      accessKey: creds.accessKeyId,
      secretKey: creds.secretAccessKey,
    })
  }

  async testConnection() {
    try {
      await this.minio.bucketExists(this.config.bucket)
      return { ok: true }
    } catch (e: any) { return { ok: false, error: e?.message } }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'putObject':    return this.putObject(params)
      case 'getObject':    return this.getObject(params)
      case 'deleteObject': return this.deleteObject(params)
      case 'listObjects':  return this.listObjects(params)
      case 'getPresignedUrl': return this.getPresignedUrl(params)
      default: throw new Error(`Unknown S3 operation: ${operation}`)
    }
  }

  private async putObject(p: Record<string, unknown>) {
    const key = p.key as string
    const body = typeof p.body === 'string' ? Buffer.from(p.body) : Buffer.from(JSON.stringify(p.body))
    const contentType = (p.contentType as string) ?? 'application/octet-stream'
    await this.minio.putObject(this.config.bucket, key, body, body.length, { 'Content-Type': contentType })
    return { bucket: this.config.bucket, key, size: body.length }
  }

  private async getObject(p: Record<string, unknown>) {
    const stream = await this.minio.getObject(this.config.bucket, p.key as string)
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
    })
  }

  private async deleteObject(p: Record<string, unknown>) {
    await this.minio.removeObject(this.config.bucket, p.key as string)
    return { deleted: true, key: p.key }
  }

  private async listObjects(p: Record<string, unknown>) {
    return new Promise((resolve, reject) => {
      const items: unknown[] = []
      const stream = this.minio.listObjectsV2(this.config.bucket, (p.prefix as string) ?? '', true)
      stream.on('data', o => items.push(o))
      stream.on('end', () => resolve(items))
      stream.on('error', reject)
    })
  }

  private async getPresignedUrl(p: Record<string, unknown>) {
    const url = await this.minio.presignedGetObject(this.config.bucket, p.key as string, (p.expirySeconds as number) ?? 3600)
    return { url }
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'putObject', label: 'Put Object', params: [{ key: 'key', label: 'Object Key', type: 'string', required: true }, { key: 'body', label: 'Body (string or JSON)', type: 'text', required: true }, { key: 'contentType', label: 'Content-Type', type: 'string' }] },
      { id: 'getObject', label: 'Get Object', params: [{ key: 'key', label: 'Object Key', type: 'string', required: true }] },
      { id: 'deleteObject', label: 'Delete Object', params: [{ key: 'key', label: 'Object Key', type: 'string', required: true }] },
      { id: 'listObjects', label: 'List Objects', params: [{ key: 'prefix', label: 'Key Prefix', type: 'string' }] },
      { id: 'getPresignedUrl', label: 'Get Presigned URL', params: [{ key: 'key', label: 'Object Key', type: 'string', required: true }, { key: 'expirySeconds', label: 'Expiry (seconds)', type: 'number' }] },
    ]
  }
}
