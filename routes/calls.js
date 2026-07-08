const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const dubberService = require('../services/dubberService');
const { RUBRICS, gradeCall, saveEvaluation } = require('../services/callGradingService');

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

router.get('/rubrics', (req, res) => {
  res.json(RUBRICS);
});

router.post('/:recordingId/evaluate', async (req, res) => {
  const { rubricType } = req.body;
  if (!rubricType || !RUBRICS[rubricType]) {
    return res.status(400).json({ error: 'A valid rubricType ("educator" or "centre") is required' });
  }
  try {
    const recording = await dubberService.getRecording(req.params.recordingId);
    const transcript = await dubberService.getTranscript(req.params.recordingId);

    const result = await gradeCall(transcript, rubricType);

    const repName = recording.from_label || recording.to_label || recording.channel || null;
    const id = await saveEvaluation({
      recordingId: req.params.recordingId,
      repName,
      callType: recording.call_type,
      rubricType,
      callDate: recording.start_time,
      durationSeconds: recording.duration,
      result,
      evaluatedBy: req.user.email
    });

    res.json({ id, repName, ...result });
  } catch (err) {
    console.error('Call evaluation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/evaluations', async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM call_evaluations ORDER BY created_at DESC LIMIT 200');
    res.json(result.rows.map(r => ({ ...r, category_scores: JSON.parse(r.category_scores) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
