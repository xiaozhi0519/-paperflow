import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import knex from 'knex'
import { logEvent } from './http-security.mjs'

const migrations = fileURLToPath(new URL('./migrations', import.meta.url))
export const requiredMigrations = ['001_initial.cjs', '002_team_collaboration.cjs', '003_research_knowledge.cjs']

export function postgresConnection(env = process.env) {
  const connectionString = env.DATABASE_URL?.trim()
  if (!connectionString) {
    if (env.NODE_ENV === 'production') throw new Error('生产模式必须配置 PostgreSQL。')
    return null
  }
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash || [...url.searchParams.keys()].some(key => key.toLowerCase().startsWith('ssl'))) throw new Error('PostgreSQL 地址不合法；TLS 请使用 PG_SSL_MODE/PG_SSL_CA_FILE。')
  const mode = env.PG_SSL_MODE || (env.NODE_ENV === 'production' ? 'verify-full' : 'disable')
  if (!['verify-full', 'disable'].includes(mode) || (env.NODE_ENV === 'production' && mode !== 'verify-full')) throw new Error('生产 PostgreSQL 必须验证 TLS 证书。')
  if (mode === 'disable' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程 PostgreSQL 必须验证 TLS 证书。')
  const ca = env.PG_SSL_CA_FILE ? readFileSync(env.PG_SSL_CA_FILE, 'utf8') : undefined
  return { connectionString, ssl: mode === 'verify-full' ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false, connectionTimeoutMillis: 5000, query_timeout: 10000 }
}

export async function openDatabase(env = process.env) {
  const dataDir = path.resolve(env.PAPERFLOW_DATA_DIR || '.paperflow-data')
  const connection = postgresConnection(env)
  const isPostgres = Boolean(connection)
  if (!isPostgres) await mkdir(dataDir, { recursive: true })
  const db = isPostgres ? knex({ client: 'pg', connection, pool: { min: 0, max: 10 }, acquireConnectionTimeout: 5000, log: { warn: () => logEvent('database_warning'), error: () => logEvent('database_error') } }) : knex({
    client: 'sqlite3', connection: { filename: path.join(dataDir, 'paperflow.sqlite') }, useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: (connection, done) => connection.run('PRAGMA foreign_keys = ON', error => done(error, connection)) },
  })
  return { db, dataDir, isPostgres }
}

export async function migrationStatus(db) {
  const applied = await db.schema.hasTable('knex_migrations') ? (await db('knex_migrations').select('name')).map(row => row.name) : []
  return { applied, pending: requiredMigrations.filter(name => !applied.includes(name)) }
}

export async function migrateDatabase(db) {
  return db.migrate.latest({ directory: migrations, loadExtensions: ['.cjs'] })
}
