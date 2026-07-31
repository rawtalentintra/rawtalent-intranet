const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');

router.use(requireAuth);

// Everyone sees every idea and who submitted it — it's a team suggestion
// box, not an anonymous inbox.
router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM ideas ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Give your idea a title' });

    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO ideas (id, title, description, submitted_by_email, submitted_by_name)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, title.trim(), description?.trim() || null, req.user.email, req.user.name || req.user.email]
    });
    const result = await getDb().execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [id] });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin moves status along and/or leaves feedback — only these two fields,
// not the original title/description, so the submitter's own wording stays
// intact as the record of what they actually asked for.
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { status, adminFeedback } = req.body;
    const validStatuses = ['new', 'in_review', 'in_progress', 'implemented', 'not_planned'];
    if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    await getDb().execute({
      sql: `UPDATE ideas SET status = COALESCE(?, status), admin_feedback = COALESCE(?, admin_feedback), updated_at = now() WHERE id = ?`,
      args: [status || null, adminFeedback ?? null, req.params.id]
    });
    const result = await getDb().execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'Idea not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
