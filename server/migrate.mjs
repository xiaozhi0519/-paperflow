import { migrateDatabase, migrationStatus, openDatabase } from './database.mjs'

if (process.argv.includes('--production')) process.env.NODE_ENV = 'production'
let database
try {
  database = await openDatabase()
  if (process.argv.includes('--status')) {
    const { applied, pending } = await migrationStatus(database.db)
    console.log(JSON.stringify({ database: database.isPostgres ? 'postgresql' : 'sqlite', applied: applied.length, pending }))
    if (pending.length) process.exitCode = 1
  } else {
    if (process.env.NODE_ENV === 'production' && !process.argv.includes('--apply')) throw new Error('生产迁移需要显式 --apply。')
    const [, migrations] = await migrateDatabase(database.db)
    console.log(`数据库迁移完成：${migrations.length} 项。`)
  }
} catch {
  console.error('数据库迁移/检查失败：请核对配置、TLS、连接与生产 --apply 授权参数；未输出连接密钥。')
  process.exitCode = 1
} finally {
  if (database) await database.db.destroy()
}
