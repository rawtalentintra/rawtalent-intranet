const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
const { BUCKETS, uploadBuffer, downloadAsBuffer, ensureBucket, extForMimetype } = require('../services/storageService');
const { extractText, runCheck } = require('../services/documentCheckerService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const EXT_MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// Compliance documents are sensitive — admin/super_admin only for now,
// same tier as everything else touching candidate/educator personal data.
router.use(requireAdmin);

const DOCUMENT_TYPES = new Set(['police_check']);

// The whole point of this feature is avoiding AI credits — OCR (free,
// self-hosted Tesseract) plus a deterministic rule set derived from our own
// SOPs (see services/documentCheckerService.js). No AI call anywhere in
// this route.
router.post('/check', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const documentType = req.body.documentType;
  if (!DOCUMENT_TYPES.has(documentType)) return res.status(400).json({ error: 'Unsupported or missing document type' });
  const candidateName = req.body.candidateName?.trim() || null;

  try {
    const { text, method, confidence } = await extractText(req.file.buffer, req.file.originalname);
    if (!text) return res.status(422).json({ error: 'No readable text could be extracted from this document.' });

    const result = runCheck(documentType, text, { candidateName });

    const db = getDb();
    const id = uuidv4();
    await ensureBucket(BUCKETS.documentCheckerFiles);
    const storagePath = `${id}.${extForMimetype(req.file.mimetype)}`;
    await uploadBuffer(BUCKETS.documentCheckerFiles, storagePath, req.file.buffer, req.file.mimetype);

    await db.execute({
      sql: `INSERT INTO document_checks (
              id, document_type, filename, storage_path, extraction_method, ocr_confidence,
              candidate_name_input, outcome, flags, reasons, extracted_fields, extracted_text,
              checked_by_email, checked_by_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, documentType, req.file.originalname, storagePath, method, confidence,
        candidateName, result.outcome, JSON.stringify(result.flags), JSON.stringify(result.reasons),
        JSON.stringify(result.extracted), text.slice(0, 20000),
        req.user.email, req.user.name || req.user.email
      ]
    });

    res.json({ id, extractionMethod: method, ocrConfidence: confidence, ...result });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const result = await getDb().execute(
      'SELECT id, document_type, filename, extraction_method, ocr_confidence, candidate_name_input, outcome, flags, reasons, extracted_fields, checked_by_email, checked_by_name, created_at FROM document_checks ORDER BY created_at DESC LIMIT 200'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/file/:id', async (req, res) => {
  try {
    const row = (await getDb().execute({ sql: 'SELECT * FROM document_checks WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row || !row.storage_path) return res.status(404).json({ error: 'File not found' });
    const buffer = await downloadAsBuffer(BUCKETS.documentCheckerFiles, row.storage_path);
    const ext = row.storage_path.split('.').pop().toLowerCase();
    res.setHeader('Content-Type', EXT_MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deleting the audit record outright (not just archiving) is kept to
// super_admin, same as the other hard-delete actions in this app.
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM document_checks WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
