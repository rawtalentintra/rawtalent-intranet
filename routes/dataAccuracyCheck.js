const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/authMiddleware');
const dataAccuracyCheckService = require('../services/dataAccuracyCheckService');

// Same sensitivity tier as Document Checker (real candidate data) —
// admin/super_admin only.
router.use(requireAdmin);

router.get('/:userId', async (req, res) => {
  try {
    res.json(await dataAccuracyCheckService.compareCandidateData(req.params.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
