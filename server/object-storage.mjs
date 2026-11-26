import path from 'node:path'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

export function readStorageConfig(env = process.env) {
  const bucket = env.S3_BUCKET?.trim() || ''
  const region = env.S3_REGION?.trim() || ''
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() || ''
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() || ''
  const endpoint = env.S3_ENDPOINT?.trim() || ''
  const configured = Boolean(bucket || region || accessKeyId || secretAccessKey || endpoint)
  if (configured && !(bucket && region && accessKeyId && secretAccessKey)) throw new Error('对象存储配置不完整。')
  if (env.NODE_ENV === 'production' && !configured) throw new Error('生产模式必须配置私有对象存储。')
  if (endpoint) {
    const url = new URL(endpoint)
    if (!(url.protocol === 'https:' || (env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('对象存储地址不合法。')
  }
  if (env.S3_FORCE_PATH_STYLE && !['true', 'false'].includes(env.S3_FORCE_PATH_STYLE)) throw new Error('S3_FORCE_PATH_STYLE 不合法。')
  return { configured, bucket, region, accessKeyId, secretAccessKey, endpoint, forcePathStyle: env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === 'true' : Boolean(endpoint) }
}

export async function createObjectStorage(dataDir, env = process.env) {
  const { configured, bucket, region, accessKeyId, secretAccessKey, endpoint, forcePathStyle } = readStorageConfig(env)
  if (configured) {
    const client = new S3Client({ region, ...(endpoint ? { endpoint } : {}), forcePathStyle, credentials: { accessKeyId, secretAccessKey } })
    return {
      kind: 's3',
      async check() { await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(3000) }) },
      async put(key, data) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: 'application/pdf' }), { abortSignal: AbortSignal.timeout(60000) }) },
      async get(key) { const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(60000) }); return Buffer.from(await result.Body.transformToByteArray()) },
      async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) }) },
      close() { client.destroy() },
    }
  }
  const directory = path.join(dataDir, 'pdf')
  await mkdir(directory, { recursive: true })
  function location(key) {
    if (!/^[0-9a-f-]{36}\.pdf$/i.test(key)) throw new Error('文件标识不合法。')
    return path.join(directory, key)
  }
  return {
    kind: 'local',
    async check() { await access(directory) },
    async put(key, data) { await writeFile(location(key), data, { flag: 'wx', mode: 0o600 }) },
    async get(key) { return readFile(location(key)) },
    async delete(key) { try { await unlink(location(key)) } catch (error) { if (error.code !== 'ENOENT') throw error } },
    close() {},
  }
}
