const express = require('express');
const router = express.Router();
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const { syncTranscripts, getSyncStatus, streamMeetingsAnswer } = require('../services/fathomService');

// Private to Joy as the only super_admin — raw meeting transcripts (Fathom
// recordings of internal calls) are far more sensitive than anything else
// in the admin panel, so this whole router is locked down, not just the
// write endpoints.
router.use(requireSuperAdmin);

router.get('/status', async (req, res) => {
  try {
    res.json(await getSyncStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const result = await syncTranscripts(req.user.email);
    res.json(result);
  } catch (err) {
    console.error('Fathom transcript sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/ask', async (req, res) => {
  const { question, history } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    await streamMeetingsAnswer(question.trim(), req.user.email, Array.isArray(history) ? history : [], res);
  } catch (err) {
    console.error('Meetings ask error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      try { res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`); res.end(); } catch {}
    }
  }
});

module.exports = router;
