import { migrateDatabase, openDatabase } from './database.mjs'

let database
try {
  database = await openDatabase()
  const [, migrations] = await migrateDatabase(database.db)
  console.log(`数据库迁移完成：${migrations.length} 项。`)
} catch {
  console.error('数据库迁移失败，请检查服务端数据库配置和连接。')
  process.exitCode = 1
} finally {
  if (database) await database.db.destroy()
}
