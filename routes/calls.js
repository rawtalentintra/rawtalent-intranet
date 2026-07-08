const express = require('express');
const router = express.Router();
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const dubberService = require('../services/dubberService');

// Call recordings are confidential — everything here is super_admin only,
// same as the FAQ Review / Slack+Fathom review queue.
router.use(requireSuperAdmin);

router.get('/status', (req, res) => {
  res.json({ dubberConfigured: dubberService.isConfigured() });
});

// Diagnostic step: confirms the connection works and shows the real API
// response shape (including where transcript data actually lives) so the
// grading logic can be built against confirmed data, not a guess.
router.get('/test-connection', async (req, res) => {
  try {
    const result = await dubberService.testConnection();
    res.json(result);
  } catch (err) {
    console.error('Dubber test connection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/recordings', async (req, res) => {
  try {
    const { count = 20, ...rest } = req.query;
    const result = await dubberService.listRecordings({ count, ...rest });
    res.json(result);
  } catch (err) {
    console.error('Dubber list recordings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic step: tries every plausible transcript endpoint for one real
// recording and reports which one(s) actually return data.
router.get('/find-transcript/:recordingId', async (req, res) => {
  try {
    const result = await dubberService.findTranscript(req.params.recordingId);
    res.json(result);
  } catch (err) {
    console.error('Dubber find-transcript error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
