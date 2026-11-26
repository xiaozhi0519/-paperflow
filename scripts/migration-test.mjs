import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import knex from 'knex'
import { openDatabase, postgresConnection, migrateDatabase, migrationStatus, requiredMigrations } from '../server/database.mjs'

async function verify(db, upgrade) {
  if (upgrade) {
    await db.migrate.up({ directory: path.resolve('server/migrations'), name: '001_initial.cjs' })
    const user = randomUUID(), team = randomUUID(), paper = randomUUID(), annotation = randomUUID()
    const now = new Date().toISOString()
    await db('users').insert({ id: user, email: 'migration@example.test', name: '迁移夹具', password_hash: 'test-only-not-a-login', created_at: now })
    await db('workspaces').insert({ id: team, name: '迁移团队', owner_id: user, created_at: now })
    await db('workspace_members').insert({ workspace_id: team, user_id: user, role: 'owner', created_at: now })
    await db('papers').insert({ id: paper, owner_id: user, workspace_id: team, storage_key: `${paper}.pdf`, file_name: 'test.pdf', file_size: 100, page_count: 2, title: '原始文献', created_at: now, updated_at: now })
    await db('annotations').insert({ id: annotation, paper_id: paper, user_id: user, page: 1, text: 'source evidence', rects: JSON.stringify([{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }]), created_at: now })
    await db('session').insert({ sid: 'migration-session', sess: JSON.stringify({ userId: user }), expire: new Date(Date.now() + 60000) })
    assert.equal((await migrationStatus(db)).pending.length, 2)
    const [, applied] = await migrateDatabase(db)
    assert.equal(applied.length, 2)
    assert.equal((await db('workspace_papers').where({ workspace_id: team, paper_id: paper }).first()).added_by_id, user)
    const row = await db('annotations').where({ id: annotation }).first()
    assert.equal(row.workspace_id, team)
    assert.equal((typeof row.rects === 'string' ? JSON.parse(row.rects) : row.rects)[0].width, 0.2)
    assert.equal((await db('papers').where({ id: paper }).first()).title, '原始文献')
    const sess = (await db('session').where({ sid: 'migration-session' }).first()).sess
    assert.equal((typeof sess === 'string' ? JSON.parse(sess) : sess).userId, user)
    await assert.rejects(() => db('knowledge_cards').insert({ id: randomUUID(), author_id: randomUUID(), updated_by_id: user, kind: 'note', status: 'open', title: 'bad reference', description: '', created_at: now, updated_at: now }))
  } else {
    assert.deepEqual((await migrationStatus(db)).pending, requiredMigrations)
    const [, applied] = await migrateDatabase(db)
    assert.equal(applied.length, 3)
  }
  assert.deepEqual((await migrationStatus(db)).pending, [])
  assert.equal((await migrateDatabase(db))[1].length, 0)
  for (const table of ['users', 'session', 'workspace_papers', 'workspace_invites', 'knowledge_cards', 'knowledge_contributions']) assert.equal(await db.schema.hasTable(table), true)
}

const root = await mkdtemp(path.join(os.tmpdir(), 'paperflow-migration-test-'))
try {
  for (const upgrade of [false, true]) {
    const { db } = await openDatabase({ NODE_ENV: 'development', PAPERFLOW_DATA_DIR: path.join(root, upgrade ? 'upgrade' : 'fresh') })
    try { await verify(db, upgrade) } finally { await db.destroy() }
  }
  console.log('真实临时 SQLite：空库 001/002/003、从 001 升级、数据/JSON/Session 保留、外键、重复迁移无变化通过。')
} finally { await rm(root, { recursive: true, force: true }) }

if (!process.env.PAPERFLOW_TEST_DATABASE_URL) {
  console.log('SKIP PostgreSQL：未提供隔离测试连接；SQLite 成功不代表 PostgreSQL 已验收。')
} else {
  let admin
  try {
    assert.equal(process.env.PAPERFLOW_DATABASE_TEST_APPROVAL, 'isolated-schema', '必须明确授权在该测试数据库中新建并清理隔离 schema。')
    const connection = postgresConnection({ ...process.env, NODE_ENV: 'development', DATABASE_URL: process.env.PAPERFLOW_TEST_DATABASE_URL })
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } })
    for (const upgrade of [false, true]) {
      const schema = `paperflow_test_${randomUUID().replaceAll('-', '')}`
      await admin.schema.createSchema(schema)
      const db = knex({ client: 'pg', connection, searchPath: [schema], migrations: { schemaName: schema }, pool: { min: 0, max: 2 } })
      try { await verify(db, upgrade) } finally { await db.destroy(); await admin.schema.dropSchema(schema, true) }
    }
    console.log('真实 PostgreSQL 隔离 schema：迁移、回填、JSON/Session、外键及重复迁移通过；未使用 public 业务表。')
  } catch {
    console.error('PostgreSQL 迁移测试未通过：检查隔离测试连接、PG_SSL_MODE/CA、schema 权限及 PAPERFLOW_DATABASE_TEST_APPROVAL=isolated-schema；未输出连接信息。')
    process.exitCode = 1
  } finally { if (admin) await admin.destroy() }
}
