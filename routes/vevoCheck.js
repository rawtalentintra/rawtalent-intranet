const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireAdmin } = require('../middleware/authMiddleware');
const vevoCheckService = require('../services/vevoCheckService');

// Same sensitivity tier as Document Checker (real candidate compliance
// data) — admin/super_admin only, matching routes/documentChecker.js's
// own router.use(requireAdmin).
router.use(requireAdmin);

// One real, human-triggered check at a time — see services/vevoCheckService.js's
// own header for the full compliance reasoning (Joy, 2026-09-12) on why
// this stays a manual, on-demand action rather than a batch/background
// sweep like Document Checker's bulk-check.
router.post('/', async (req, res) => {
  const { candidateId, candidateName, documentType, referenceType, referenceNumber, dateOfBirth, country } = req.body;
  if (!documentType || !referenceType || !referenceNumber || !dateOfBirth || !country) {
    return res.status(400).json({ error: 'documentType, referenceType, referenceNumber, dateOfBirth, and country are all required.' });
  }
  try {
    const result = await vevoCheckService.runVevoCheck({
      candidateId: candidateId || null, candidateName: candidateName || null,
      documentType, referenceType, referenceNumber, dateOfBirth, country,
      checkedByEmail: req.user.email, checkedByName: req.user.name
    });
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

router.get('/for-candidate/:candidateId', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: `SELECT id, document_type, reference_type, reference_number, date_of_birth, country,
                   outcome, result, error_message, checked_by_email, checked_by_name, created_at
            FROM vevo_checks WHERE candidate_id = ? ORDER BY created_at DESC`,
      args: [req.params.candidateId]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
