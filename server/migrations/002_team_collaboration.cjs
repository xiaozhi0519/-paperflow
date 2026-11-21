exports.up = async function up(knex) {
  await knex.schema.createTable('workspace_papers', table => {
    table.string('workspace_id', 36).notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
    table.string('paper_id', 36).notNullable().references('id').inTable('papers').onDelete('CASCADE')
    table.string('added_by_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('created_at', 30).notNullable()
    table.primary(['workspace_id', 'paper_id'])
    table.index('paper_id')
    table.index('added_by_id')
  })
  await knex.raw('INSERT INTO workspace_papers (workspace_id, paper_id, added_by_id, created_at) SELECT workspace_id, id, owner_id, created_at FROM papers WHERE workspace_id IS NOT NULL')

  await knex.schema.alterTable('annotations', table => {
    table.string('workspace_id', 36).nullable().references('id').inTable('workspaces').onDelete('CASCADE')
    table.index(['paper_id', 'workspace_id'])
  })
  await knex.raw('UPDATE annotations SET workspace_id = (SELECT workspace_id FROM papers WHERE papers.id = annotations.paper_id)')

  await knex.schema.alterTable('comments', table => {
    table.string('workspace_id', 36).nullable().references('id').inTable('workspaces').onDelete('CASCADE')
    table.string('parent_id', 36).nullable().references('id').inTable('comments').onDelete('CASCADE')
    table.string('annotation_id', 36).nullable().references('id').inTable('annotations').onDelete('SET NULL')
    table.index(['paper_id', 'workspace_id', 'created_at'])
    table.index('parent_id')
  })

  await knex.schema.createTable('discussion_summaries', table => {
    table.string('id', 36).primary()
    table.string('paper_id', 36).notNullable().references('id').inTable('papers').onDelete('CASCADE')
    table.string('workspace_id', 36).notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
    table.string('thread_id', 36).nullable().references('id').inTable('comments').onDelete('SET NULL')
    table.string('author_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.text('content').notNullable()
    table.string('model', 120).notNullable().defaultTo('')
    table.string('created_at', 30).notNullable()
    table.index(['paper_id', 'workspace_id', 'created_at'])
    table.index('author_id')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('discussion_summaries')
  await knex.schema.alterTable('comments', table => {
    table.dropIndex('parent_id')
    table.dropIndex(['paper_id', 'workspace_id', 'created_at'])
    table.dropColumn('parent_id')
    table.dropColumn('annotation_id')
    table.dropColumn('workspace_id')
  })
  await knex.schema.alterTable('annotations', table => {
    table.dropIndex(['paper_id', 'workspace_id'])
    table.dropColumn('workspace_id')
  })
  await knex.schema.dropTableIfExists('workspace_papers')
}
