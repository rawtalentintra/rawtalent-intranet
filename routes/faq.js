const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth, requireSuperAdmin } = require('../middleware/authMiddleware');
const { runSlackScan, isConfigured: isSlackConfigured } = require('../services/slackService');
const { runFathomScan, isConfigured: isFathomConfigured } = require('../services/fathomService');
const { logActivity } = require('../services/activityLog');

async function upsertFaqFts(id, question, answer) {
  const db = getDb();
  try {
    await db.execute({ sql: 'DELETE FROM faqs_fts WHERE id = ?', args: [id] });
    await db.execute({ sql: 'INSERT INTO faqs_fts(id, question, answer) VALUES (?, ?, ?)', args: [id, question, answer] });
  } catch {}
}
async function deleteFaqFts(id) {
  try { await getDb().execute({ sql: 'DELETE FROM faqs_fts WHERE id = ?', args: [id] }); } catch {}
}

// ── Public — any authenticated user can view approved FAQs ────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await getDb().execute('SELECT id, question, answer, created_at FROM faqs ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Everything below is super_admin only — raw Slack content and ──
// ── the review queue are confidential until a human approves them ──
router.use(requireSuperAdmin);

router.get('/status', (req, res) => {
  res.json({ slackConfigured: isSlackConfigured(), fathomConfigured: isFathomConfigured() });
});

router.post('/scan/slack', async (req, res) => {
  try {
    const result = await runSlackScan(req.user.email);
    res.json(result);
  } catch (err) {
    console.error('Slack scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/scan/fathom', async (req, res) => {
  try {
    const result = await runFathomScan(req.user.email);
    res.json(result);
  } catch (err) {
    console.error('Fathom scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// status=all returns every scanned conversation regardless of outcome — this is the
// audit trail a super_admin can use to see exactly what Slack/Fathom content was
// looked at, including things Claude itself auto-rejected before a human ever saw them.
// Optional source=slack|fathom narrows it further.
router.get('/candidates', async (req, res) => {
  try {
    const { status = 'pending', source } = req.query;
    const conditions = [];
    const args = [];
    if (status !== 'all') { conditions.push('status = ?'); args.push(status); }
    if (source) { conditions.push('source = ?'); args.push(source); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await getDb().execute({
      sql: `SELECT * FROM faq_candidates ${where} ORDER BY created_at DESC LIMIT 300`,
      args
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/candidates/:id/approve', async (req, res) => {
  const { question, answer } = req.body;
  try {
    const db = getDb();
    const candRes = await db.execute({ sql: 'SELECT * FROM faq_candidates WHERE id = ?', args: [req.params.id] });
    const candidate = candRes.rows[0];
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    const finalQuestion = (question || candidate.suggested_question).trim();
    const finalAnswer = (answer || candidate.suggested_answer).trim();
    const id = uuidv4();

    await db.execute({
      sql: 'INSERT INTO faqs (id, question, answer, source, source_date, approved_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, finalQuestion, finalAnswer, candidate.source, candidate.source_date, req.user.email]
    });
    await upsertFaqFts(id, finalQuestion, finalAnswer);

    await db.execute({
      sql: "UPDATE faq_candidates SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
      args: [req.user.email, req.params.id]
    });

    await logActivity('faq', finalQuestion, 'approved', `FAQ approved from ${candidate.source}`, req.user.email);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/candidates/:id/reject', async (req, res) => {
  try {
    await getDb().execute({
      sql: "UPDATE faq_candidates SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
      args: [req.user.email, req.params.id]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/candidates/:id', async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM faq_candidates WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/manage/all', async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM faqs ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });
  try {
    const db = getDb();
    await db.execute({
      sql: "UPDATE faqs SET question=?, answer=?, updated_at=datetime('now') WHERE id=?",
      args: [question.trim(), answer.trim(), req.params.id]
    });
    await upsertFaqFts(req.params.id, question.trim(), answer.trim());
    await logActivity('faq', question.trim(), 'updated', 'FAQ edited', req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT question FROM faqs WHERE id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM faqs WHERE id = ?', args: [req.params.id] });
    await deleteFaqFts(req.params.id);
    if (existing.rows[0]) await logActivity('faq', existing.rows[0].question, 'deleted', 'FAQ removed', req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
