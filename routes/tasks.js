const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/authMiddleware');

// Every signed-in user, any role — this is the whole point of the feature
// (see public/index.html's Tasks tab). No role gate at all.
router.use(requireAuth);

const STATUSES = ['to_do', 'in_progress', 'blocked', 'in_review', 'done'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// Finds @Name mentions in a note body against the known active-user list and
// returns the matched emails. Matches on full display name (case-insensitive,
// longest names first so "Joy Smith" doesn't get eaten by a bare "@Joy"
// match first) — simple substring match, no fancy tokenizing, since the
// frontend's autocomplete is what actually inserts these mentions.
function extractMentions(body, users) {
  if (!body) return [];
  const found = new Set();
  const sorted = [...users].sort((a, b) => (b.name || b.email).length - (a.name || a.email).length);
  for (const u of sorted) {
    const label = (u.name || u.email.split('@')[0]).trim();
    if (!label) continue;
    const needle = `@${label}`.toLowerCase();
    if (body.toLowerCase().includes(needle)) found.add(u.email.toLowerCase());
  }
  return [...found];
}

// Shared by task create/update — description mentions are recomputed on
// every save (unlike task_notes.mentioned_emails, which freezes at the
// moment a note is posted), since a description is a mutable field, not a
// running log.
async function resolveDescriptionMentions(db, description, excludeEmail) {
  const usersRes = await db.execute("SELECT email, name FROM users WHERE active = true");
  return extractMentions(description || '', usersRes.rows).filter(e => e.toLowerCase() !== excludeEmail.toLowerCase());
}

// Full dataset, client-side grouping/filtering — same convention as Leads/
// Reports/My Centres in this codebase, rather than server-side query params.
router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute(`
      SELECT t.*, tc.name AS classification_name
      FROM tasks t
      LEFT JOIN task_classifications tc ON tc.id = t.classification_id
      ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Departments, classifications, and the active-user list a task can be
// assigned to / a note can @mention — one call so the frontend can build
// every dropdown before the first render.
router.get('/meta', async (req, res) => {
  try {
    const db = getDb();
    const [depts, classifications, users] = await Promise.all([
      db.execute('SELECT * FROM task_departments ORDER BY sort_order ASC'),
      db.execute('SELECT * FROM task_classifications ORDER BY name ASC'),
      db.execute("SELECT email, name, role FROM users WHERE active = true ORDER BY name ASC NULLS LAST, email ASC")
    ]);
    res.json({ departments: depts.rows, classifications: classifications.rows, users: users.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/classifications', async (req, res) => {
  const { department_id, name } = req.body;
  if (!department_id?.trim() || !name?.trim()) return res.status(400).json({ error: 'department_id and name are required' });
  try {
    const db = getDb();
    const dept = await db.execute({ sql: 'SELECT id FROM task_departments WHERE id = ?', args: [department_id] });
    if (!dept.rows[0]) return res.status(404).json({ error: 'Department not found' });

    // Reuse an existing classification with the same name in this
    // department rather than creating a visually-identical duplicate.
    const existing = await db.execute({
      sql: 'SELECT * FROM task_classifications WHERE department_id = ? AND LOWER(name) = LOWER(?)',
      args: [department_id, name.trim()]
    });
    if (existing.rows[0]) return res.json({ success: true, classification: existing.rows[0] });

    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO task_classifications (id, department_id, name, created_by) VALUES (?, ?, ?, ?)',
      args: [id, department_id, name.trim(), req.user.email]
    });
    const row = await db.execute({ sql: 'SELECT * FROM task_classifications WHERE id = ?', args: [id] });
    res.json({ success: true, classification: row.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { department_id, classification_id, title, description, status, priority, assigned_to, due_date } = req.body;
  if (!department_id?.trim()) return res.status(400).json({ error: 'Department is required' });
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (priority && !PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  try {
    const db = getDb();
    const id = uuidv4();
    const finalStatus = status || 'to_do';
    const mentioned = await resolveDescriptionMentions(db, description, req.user.email);
    await db.execute({
      sql: `INSERT INTO tasks
            (id, department_id, classification_id, title, description, status, priority, assigned_to, due_date, created_by, created_by_name, completed_at, mentioned_emails)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, department_id, classification_id || null, title.trim(), description || null,
        finalStatus, priority || 'normal', assigned_to || null, due_date || null,
        req.user.email, req.user.name || req.user.email,
        finalStatus === 'done' ? new Date().toISOString() : null,
        JSON.stringify(mentioned)
      ]
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { department_id, classification_id, title, description, status, priority, assigned_to, due_date } = req.body;
  if (!department_id?.trim()) return res.status(400).json({ error: 'Department is required' });
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (priority && !PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT status, completed_at FROM tasks WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Task not found' });
    const finalStatus = status || existing.rows[0].status;
    // completed_at only gets set the moment status actually transitions
    // into 'done', and clears if it's reopened — not touched on every save.
    let completedAt = existing.rows[0].completed_at;
    if (finalStatus === 'done' && existing.rows[0].status !== 'done') completedAt = new Date().toISOString();
    else if (finalStatus !== 'done') completedAt = null;
    const mentioned = await resolveDescriptionMentions(db, description, req.user.email);

    await db.execute({
      sql: `UPDATE tasks SET
              department_id=?, classification_id=?, title=?, description=?, status=?, priority=?,
              assigned_to=?, due_date=?, completed_at=?, mentioned_emails=?, updated_at=now()
            WHERE id=?`,
      args: [
        department_id, classification_id || null, title.trim(), description || null, finalStatus,
        priority || 'normal', assigned_to || null, due_date || null, completedAt, JSON.stringify(mentioned), req.params.id
      ]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.execute({ sql: 'DELETE FROM task_notes WHERE task_id = ?', args: [req.params.id] });
    const result = await db.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [req.params.id] });
    if (!result.rowsAffected) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/notes', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC',
      args: [req.params.id]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/notes', async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Note text is required' });
  try {
    const db = getDb();
    const task = await db.execute({ sql: 'SELECT id, title FROM tasks WHERE id = ?', args: [req.params.id] });
    if (!task.rows[0]) return res.status(404).json({ error: 'Task not found' });

    const usersRes = await db.execute("SELECT email, name FROM users WHERE active = true");
    const mentioned = extractMentions(body, usersRes.rows).filter(e => e.toLowerCase() !== req.user.email.toLowerCase());

    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO task_notes (id, task_id, body, author_email, author_name, mentioned_emails)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, req.params.id, body.trim(), req.user.email, req.user.name || req.user.email, JSON.stringify(mentioned)]
    });
    const row = await db.execute({ sql: 'SELECT * FROM task_notes WHERE id = ?', args: [id] });
    res.json({ success: true, note: row.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
