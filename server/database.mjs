import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import knex from 'knex'

const migrations = fileURLToPath(new URL('./migrations', import.meta.url))

export async function openDatabase(env = process.env) {
  const dataDir = path.resolve(env.PAPERFLOW_DATA_DIR || '.paperflow-data')
  const isPostgres = Boolean(env.DATABASE_URL?.trim())
  if (env.NODE_ENV === 'production' && !isPostgres) throw new Error('生产模式必须配置 PostgreSQL。')
  if (!isPostgres) await mkdir(dataDir, { recursive: true })
  const db = isPostgres ? knex({ client: 'pg', connection: env.DATABASE_URL, pool: { min: 0, max: 10 } }) : knex({
    client: 'sqlite3', connection: { filename: path.join(dataDir, 'paperflow.sqlite') }, useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: (connection, done) => connection.run('PRAGMA foreign_keys = ON', error => done(error, connection)) },
  })
  return { db, dataDir, isPostgres }
}

export async function migrateDatabase(db) {
  return db.migrate.latest({ directory: migrations, loadExtensions: ['.cjs'] })
}
