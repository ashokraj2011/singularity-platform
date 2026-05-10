import * as Minio from 'minio'
import { config } from '../config'

export const minioClient = new Minio.Client({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
})

export async function ensureBucket(): Promise<void> {
  const exists = await minioClient.bucketExists(config.MINIO_BUCKET)
  if (!exists) {
    await minioClient.makeBucket(config.MINIO_BUCKET)
    console.log(`Created MinIO bucket: ${config.MINIO_BUCKET}`)
  }
}
