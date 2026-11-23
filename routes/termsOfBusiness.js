// Terms of Business per company (Liam 23 Nov 2026), modelled on Signed Contracts
// (Liam 15 Oct, Joy 16 Oct). Only the three people in
// CONTRACT_VIEWERS can reach any route here — checked on every request.
// Files are private and opened through signed URLs that expire in 5 minutes.
// Nothing is ever hard-deleted (see db/schema.sql's terms_of_business).
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../db/database');
const { canViewContracts } = require('./signedContracts');
const { BUCKETS, ensureBucket, uploadBuffer, getSignedUrl } = require('../services/storageService');

const ALLOWED_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.use((req, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (!canViewContracts(req.user)) return res.status(404).json({ error: 'Not found' });
  next();
});

const logEvent = (contractId, action, user) => getDb().execute({
  sql: 'INSERT INTO terms_of_business_events (terms_id, action, user_email, user_name) VALUES (?, ?, ?, ?)',
  args: [contractId, action, user.email, user.name || user.email]
}).catch(err => console.error('Contract event log failed:', err.message));

router.get('/', async (req, res) => {
  try {
    const status = req.query.status === 'all' ? null : 'active';
    const rows = (await getDb().execute({
      sql: `SELECT c.id, c.company_name, c.signed_date, c.notes, c.filename, c.filesize, c.status, c.uploaded_by_name, c.created_at,
                   (SELECT count(*) FROM terms_of_business p WHERE p.replaced_by_id = c.id) AS previous_versions
            FROM terms_of_business c ${status ? "WHERE c.status = 'active'" : ''} ORDER BY c.company_name, c.created_at DESC`,
      args: []
    })).rows;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function storeFile(req) {
  if (!req.file) throw Object.assign(new Error('Choose a PDF or Word file'), { status: 400 });
  if (!ALLOWED_TYPES.includes(req.file.mimetype)) throw Object.assign(new Error('Only PDF or Word files can be uploaded'), { status: 400 });
  await ensureBucket(BUCKETS.termsOfBusiness);
  const ext = { 'application/pdf': 'pdf', 'application/msword': 'doc' }[req.file.mimetype] || 'docx';
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  await uploadBuffer(BUCKETS.termsOfBusiness, path, req.file.buffer, req.file.mimetype);
  return path;
}

router.post('/', upload.single('file'), async (req, res) => {
  try {
    const name = String(req.body.companyName || '').trim();
    if (!name) return res.status(400).json({ error: 'Company name is required' });
    const path = await storeFile(req);
    const row = (await getDb().execute({
      sql: `INSERT INTO terms_of_business (company_name, signed_date, notes, filename, mimetype, filesize, storage_path, uploaded_by_email, uploaded_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [name, /^\d{4}-\d{2}-\d{2}$/.test(req.body.signedDate || '') ? req.body.signedDate : null, String(req.body.notes || '').trim() || null,
             req.file.originalname, req.file.mimetype, req.file.size, path, req.user.email, req.user.name || req.user.email]
    })).rows[0];
    await logEvent(row.id, 'uploaded', req.user);
    res.status(201).json({ id: row.id });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Replace: a new row becomes the active contract; the old one is kept as 'replaced'.
router.post('/:id/replace', upload.single('file'), async (req, res) => {
  try {
    const db = getDb();
    const old = (await db.execute({ sql: "SELECT * FROM terms_of_business WHERE id = ? AND status = 'active'", args: [req.params.id] })).rows[0];
    if (!old) return res.status(404).json({ error: 'Terms not found' });
    const path = await storeFile(req);
    const row = (await db.execute({
      sql: `INSERT INTO terms_of_business (company_name, signed_date, notes, filename, mimetype, filesize, storage_path, uploaded_by_email, uploaded_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [old.company_name, old.signed_date, old.notes, req.file.originalname, req.file.mimetype, req.file.size, path, req.user.email, req.user.name || req.user.email]
    })).rows[0];
    await db.execute({ sql: "UPDATE terms_of_business SET status = 'replaced', replaced_by_id = ? WHERE id = ?", args: [row.id, old.id] });
    await logEvent(old.id, 'replaced', req.user);
    await logEvent(row.id, 'uploaded', req.user);
    res.status(201).json({ id: row.id });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/:id/archive', async (req, res) => {
  try {
    const r = await getDb().execute({ sql: "UPDATE terms_of_business SET status = 'archived' WHERE id = ? AND status = 'active' RETURNING id", args: [req.params.id] });
    if (!r.rows[0]) return res.status(404).json({ error: 'Terms not found' });
    await logEvent(Number(req.params.id), 'archived', req.user);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Opens the file: returns a signed URL valid for 5 minutes, and records the view.
router.get('/:id/open', async (req, res) => {
  try {
    const c = (await getDb().execute({ sql: 'SELECT id, storage_path FROM terms_of_business WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!c) return res.status(404).json({ error: 'Terms not found' });
    const url = await getSignedUrl(BUCKETS.termsOfBusiness, c.storage_path, 300);
    await logEvent(c.id, 'viewed', req.user);
    res.json({ url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/history', async (req, res) => {
  try {
    const rows = (await getDb().execute({ sql: 'SELECT action, user_name, created_at FROM terms_of_business_events WHERE terms_id = ? ORDER BY created_at DESC LIMIT 50', args: [req.params.id] })).rows;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
