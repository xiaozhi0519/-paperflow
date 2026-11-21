exports.up = async function up(knex) {
  await knex.schema.alterTable('workspaces', table => {
    table.text('description').notNullable().defaultTo('')
  })
  await knex.schema.createTable('workspace_invites', table => {
    table.string('workspace_id', 36).primary().references('id').inTable('workspaces').onDelete('CASCADE')
    table.string('token_hash', 64).notNullable().unique()
    table.string('expires_at', 30).notNullable()
  })
  await knex.schema.createTable('knowledge_cards', table => {
    table.string('id', 36).primary()
    table.string('workspace_id', 36).nullable().references('id').inTable('workspaces').onDelete('CASCADE')
    table.string('author_id', 36).notNullable().references('id').inTable('users').onDelete('RESTRICT')
    table.string('updated_by_id', 36).notNullable().references('id').inTable('users').onDelete('RESTRICT')
    table.enu('kind', ['question', 'note', 'record'], { useNative: false }).notNullable()
    table.enu('status', ['open', 'investigating', 'resolved'], { useNative: false }).notNullable().defaultTo('open')
    table.string('title', 200).notNullable()
    table.text('description').notNullable()
    table.string('paper_id', 36).nullable().references('id').inTable('papers').onDelete('CASCADE')
    table.string('annotation_id', 36).nullable().references('id').inTable('annotations').onDelete('SET NULL')
    table.string('comment_id', 36).nullable().references('id').inTable('comments').onDelete('SET NULL')
    table.string('created_at', 30).notNullable()
    table.string('updated_at', 30).notNullable()
    table.index(['workspace_id', 'created_at'])
    table.index('author_id')
  })
  await knex.schema.createTable('knowledge_contributions', table => {
    table.string('id', 36).primary()
    table.string('card_id', 36).notNullable().references('id').inTable('knowledge_cards').onDelete('CASCADE')
    table.string('user_id', 36).notNullable().references('id').inTable('users').onDelete('RESTRICT')
    table.string('action', 20).notNullable()
    table.string('created_at', 30).notNullable()
    table.index(['card_id', 'created_at'])
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTable('knowledge_contributions')
  await knex.schema.dropTable('knowledge_cards')
  await knex.schema.dropTable('workspace_invites')
  await knex.schema.alterTable('workspaces', table => { table.dropColumn('description') })
}
