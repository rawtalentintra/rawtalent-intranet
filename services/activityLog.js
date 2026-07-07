const { getDb } = require('../db/database');

// Records an entry in the system activity log (user, glossary, and FAQ management actions).
// Article changes have their own dedicated article_logs table/history.
async function logActivity(entityType, entityLabel, action, summary, changedBy) {
  try {
    await getDb().execute({
      sql: 'INSERT INTO system_logs (entity_type, entity_label, action, changes_summary, changed_by) VALUES (?, ?, ?, ?, ?)',
      args: [entityType, entityLabel, action, summary, changedBy]
    });
  } catch (err) {
    console.error('Failed to write system log:', err.message);
  }
}

module.exports = { logActivity };
