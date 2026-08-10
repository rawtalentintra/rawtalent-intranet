const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
const { extractText, runCheck } = require('../services/documentCheckerService');

// Compliance documents are sensitive — admin/super_admin only for now,
// same tier as everything else touching candidate/educator personal data.
router.use(requireAdmin);

// Only RT's own requirementName strings that have a real rule set in
// documentCheckerService.js map to something — everything else on a
// candidate's Documents list (Passport, First Aid, etc.) shows as "not yet
// supported" in the UI rather than silently failing or guessing.
const REQUIREMENT_NAME_TO_TYPE = { 'Police Check': 'police_check' };

// Documents are never uploaded here — they're fetched server-side from the
// URL RT already gives us on the candidate's own attachedRequirements[]
// (documentPath, an S3 link). Restricting fetches to RT's own document
// host stops this from becoming an open URL-fetch proxy for whoever calls
// it — an admin session is already required, but this is a second,
// independent guard against the one thing that gate doesn't cover (this
// route making an unexpected outbound request on the server's behalf).
const ALLOWED_DOCUMENT_HOSTS = /(^|\.)amazonaws\.com$/i;

async function fetchRtDocument(documentPath) {
  let url;
  try { url = new URL(documentPath); } catch { throw new Error('Invalid document URL'); }
  if (!ALLOWED_DOCUMENT_HOSTS.test(url.hostname)) {
    throw new Error(`Refusing to fetch a document from an unrecognised host (${url.hostname})`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the document from RT (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const filename = decodeURIComponent(url.pathname.split('/').pop() || 'document');
  return { buffer, filename };
}

// The whole point of this feature is avoiding AI credits — OCR (free,
// self-hosted Tesseract) plus a deterministic rule set derived from our own
// SOPs (see services/documentCheckerService.js). No AI call anywhere in
// this route. One row per check run (append-only — see schema.sql), so
// re-checking a document after RT shows an updated file just adds a new
// row rather than overwriting the last result.
router.post('/check-from-rt', async (req, res) => {
  const { candidateId, candidateName, userDocumentDetailId, requirementName, documentPath } = req.body;
  if (!candidateId || !userDocumentDetailId || !requirementName || !documentPath) {
    return res.status(400).json({ error: 'candidateId, userDocumentDetailId, requirementName, and documentPath are required' });
  }
  const documentType = REQUIREMENT_NAME_TO_TYPE[requirementName];
  if (!documentType) return res.status(400).json({ error: `No automated check is available yet for "${requirementName}"` });

  try {
    const { buffer, filename } = await fetchRtDocument(documentPath);
    const { text, method, confidence } = await extractText(buffer, filename);
    if (!text) return res.status(422).json({ error: 'No readable text could be extracted from this document.' });

    const result = runCheck(documentType, text, { candidateName: candidateName || null });

    const db = getDb();
    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO document_checks (
              id, document_type, filename, extraction_method, ocr_confidence,
              candidate_name_input, outcome, flags, reasons, extracted_fields, extracted_text,
              checked_by_email, checked_by_name,
              candidate_id, user_document_detail_id, requirement_name, document_source_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, documentType, filename, method, confidence,
        candidateName || null, result.outcome, JSON.stringify(result.flags), JSON.stringify(result.reasons),
        JSON.stringify(result.extracted), text.slice(0, 20000),
        req.user.email, req.user.name || req.user.email,
        candidateId, userDocumentDetailId, requirementName, documentPath
      ]
    });

    res.json({ id, extractionMethod: method, ocrConfidence: confidence, reviewed: false, ...result });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// The latest check per requirement for one candidate — what the Candidate
// Documents tab renders. DISTINCT ON picks the newest row per
// user_document_detail_id in one query rather than the app filtering a
// full history client-side.
router.get('/for-candidate/:candidateId', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: `SELECT DISTINCT ON (user_document_detail_id) *
            FROM document_checks
            WHERE candidate_id = ?
            ORDER BY user_document_detail_id, created_at DESC`,
      args: [req.params.candidateId]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Human confirms/annotates one specific automated result — reviewed and
// review_notes belong to that check row, not the requirement in general,
// so a fresh re-check naturally starts unreviewed again rather than
// silently inheriting an approval that was given to a different file.
router.put('/:id/review', async (req, res) => {
  const { reviewed, notes } = req.body;
  try {
    const result = await getDb().execute({
      sql: `UPDATE document_checks SET reviewed = ?, reviewed_by = ?, reviewed_at = now(), review_notes = ? WHERE id = ?`,
      args: [!!reviewed, req.user.email, (notes || '').trim() || null, req.params.id]
    });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Check not found' });
    const row = (await getDb().execute({ sql: 'SELECT * FROM document_checks WHERE id = ?', args: [req.params.id] })).rows[0];
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit log across every candidate — not the primary workflow (that's the
// candidate's own Documents tab) but useful for oversight of what's been
// checked and by whom.
router.get('/history', async (req, res) => {
  try {
    const result = await getDb().execute(
      `SELECT id, document_type, filename, extraction_method, ocr_confidence, candidate_name_input, candidate_id,
              requirement_name, outcome, flags, reasons, extracted_fields, reviewed, reviewed_by, reviewed_at,
              review_notes, checked_by_email, checked_by_name, created_at, document_source_url
       FROM document_checks ORDER BY created_at DESC LIMIT 200`
    );
    res.json(result.rows);
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
