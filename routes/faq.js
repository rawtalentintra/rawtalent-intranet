const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth, requireSuperAdmin, requireRole } = require('../middleware/authMiddleware');
const { runSlackScan, isConfigured: isSlackConfigured } = require('../services/slackService');
const { runFathomScan, isConfigured: isFathomConfigured } = require('../services/fathomService');
const { extractFaqsFromDocument } = require('../services/faqClassifier');
const { extractPlainText } = require('../services/documentTextExtractor');
const { logActivity } = require('../services/activityLog');

const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── Public — any authenticated user can view approved FAQs ────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await getDb().execute('SELECT id, question, answer, created_at FROM faqs ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FAQ management (view/add/edit only, no delete) — super_admin, plain ──
// ── admin, and qa_view all get this: writing/correcting FAQ answers, with ──
// ── no access to the raw Slack/Fathom scan or review queue (still ──
// ── super_admin-only below). ──
router.get('/manage/all', requireRole('super_admin', 'admin', 'qa_view'), async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM faqs ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireRole('super_admin', 'admin', 'qa_view'), async (req, res) => {
  const { question, answer } = req.body;
  if (!question?.trim() || !answer?.trim()) return res.status(400).json({ error: 'Question and answer are required' });
  try {
    const db = getDb();
    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO faqs (id, question, answer, source, approved_by) VALUES (?, ?, ?, ?, ?)',
      args: [id, question.trim(), answer.trim(), 'manual', req.user.email]
    });
    await logActivity('faq', question.trim(), 'created', 'FAQ added manually', req.user.email);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireRole('super_admin', 'admin', 'qa_view'), async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });
  try {
    const db = getDb();
    await db.execute({
      sql: "UPDATE faqs SET question=?, answer=?, updated_at=now() WHERE id=?",
      args: [question.trim(), answer.trim(), req.params.id]
    });
    await logActivity('faq', question.trim(), 'updated', 'FAQ edited', req.user.email);
    res.json({ success: true });
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

// Uploads a document, extracts its text, and asks Claude to pull out every
// genuinely reusable FAQ it can find — each becomes a normal pending
// candidate, reviewed/edited/approved exactly like a Slack or Fathom one.
router.post('/scan/document', docUpload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const text = await extractPlainText(req.file.buffer, req.file.originalname);
    if (!text.trim()) return res.status(400).json({ error: 'No readable text found in this document' });

    const { candidates } = await extractFaqsFromDocument(text, req.file.originalname);
    const db = getDb();
    let candidatesFound = 0;
    for (const c of candidates) {
      if (!c.question?.trim() || !c.answer?.trim()) continue;
      const id = uuidv4();
      await db.execute({
        sql: `INSERT INTO faq_candidates
              (id, source, source_ref, raw_excerpt, suggested_question, suggested_answer, classification_reason)
              VALUES (?, 'document', ?, ?, ?, ?, ?)`,
        args: [id, req.file.originalname, text.slice(0, 2000), c.question.trim(), c.answer.trim(), 'Extracted from uploaded document']
      });
      candidatesFound++;
    }
    res.json({ docTitle: req.file.originalname, candidatesFound });
  } catch (err) {
    console.error('Document scan error:', err.message);
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

    await db.execute({
      sql: "UPDATE faq_candidates SET status = 'approved', reviewed_by = ?, reviewed_at = now() WHERE id = ?",
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
      sql: "UPDATE faq_candidates SET status = 'rejected', reviewed_by = ?, reviewed_at = now() WHERE id = ?",
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

router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT question FROM faqs WHERE id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM faqs WHERE id = ?', args: [req.params.id] });
    if (existing.rows[0]) await logActivity('faq', existing.rows[0].question, 'deleted', 'FAQ removed', req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
