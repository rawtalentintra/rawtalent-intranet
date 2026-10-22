// RTO lookup (services/rtoLookupService.js) — read-only, admin team.
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/authMiddleware');
const svc = require('../services/rtoLookupService');
router.use(requireRole('admin', 'super_admin', 'qa_view'));
router.get('/search', async (req, res) => {
  try { res.json(await svc.search(req.query.q)); } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
});
router.get('/:code', async (req, res) => {
  try {
    const d = await svc.details(req.params.code, req.query.qualification);
    if (!d) return res.status(404).json({ error: 'No RTO with that number on training.gov.au' });
    res.json(d);
  } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
});
module.exports = router;
