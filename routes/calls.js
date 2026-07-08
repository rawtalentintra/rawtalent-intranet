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

// Pulls recent recordings from Dubber and stores metadata locally. Click again
// later to keep extending how far back the local store goes.
router.post('/sync', async (req, res) => {
  try {
    const result = await dubberService.syncRecordings();
    res.json(result);
  } catch (err) {
    console.error('Dubber sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sync-status', async (req, res) => {
  try {
    const [state, count] = await Promise.all([
      getDb().execute('SELECT * FROM dubber_sync_state WHERE id = 1'),
      getDb().execute('SELECT COUNT(*) as n FROM call_recordings')
    ]);
    res.json({ ...(state.rows[0] || {}), totalStored: Number(count.rows[0].n) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Browses the local cache — filterable, paginated, never hits Dubber's API.
router.get('/local', async (req, res) => {
  try {
    const { repName, phone, dateFrom, dateTo, page = 1, pageSize = 25 } = req.query;
    const conditions = [];
    const args = [];
    if (repName) { conditions.push('rep_name LIKE ?'); args.push(`%${repName}%`); }
    if (phone) { conditions.push('(to_number LIKE ? OR from_number LIKE ?)'); args.push(`%${phone}%`, `%${phone}%`); }
    if (dateFrom) { conditions.push('start_time_iso >= ?'); args.push(new Date(dateFrom).toISOString()); }
    if (dateTo) { conditions.push('start_time_iso <= ?'); args.push(new Date(dateTo).toISOString()); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const offset = (Math.max(1, Number(page)) - 1) * Number(pageSize);
    const db = getDb();
    const [rows, countRes] = await Promise.all([
      db.execute({ sql: `SELECT * FROM call_recordings ${where} ORDER BY start_time_iso DESC LIMIT ? OFFSET ?`, args: [...args, Number(pageSize), offset] }),
      db.execute({ sql: `SELECT COUNT(*) as n FROM call_recordings ${where}`, args })
    ]);
    res.json({ recordings: rows.rows, total: Number(countRes.rows[0].n), page: Number(page), pageSize: Number(pageSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/local/:id', async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM call_recordings WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'Call not found in local store' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serves audio that was already fetched and stored at sync time.
router.get('/local/:id/audio', async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM call_recording_audio WHERE recording_id = ?', args: [req.params.id] });
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Audio not synced for this call yet' });
    const buffer = Buffer.from(row.data, 'base64');
    res.setHeader('Content-Type', row.mimetype || 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic only — surfaces the raw recording detail response so we can find
// which field actually holds a playable audio URL before building real
// playback controls into the UI.
router.get('/:recordingId/playback-info', async (req, res) => {
  try {
    const result = await dubberService.getRecordingPlaybackInfo(req.params.recordingId, req.query.listener);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic step: tries every plausible transcript endpoint for one real
// recording and reports which one(s) actually return data. Requests are spaced
// out to respect Dubber's 2 calls/second limit.
router.get('/find-transcript/:recordingId', async (req, res) => {
  try {
    const result = await dubberService.findTranscript(req.params.recordingId);
    res.json(result);
  } catch (err) {
    console.error('Dubber find-transcript error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic step: same approach, but for finding a playable audio URL.
router.get('/find-playback/:recordingId', async (req, res) => {
  try {
    const result = await dubberService.findPlayback(req.params.recordingId);
    res.json(result);
  } catch (err) {
    console.error('Dubber find-playback error:', err.message);
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
    const db = getDb();
    const localRes = await db.execute({ sql: 'SELECT * FROM call_recordings WHERE id = ?', args: [req.params.recordingId] });
    const local = localRes.rows[0];

    // Prefer the local cache for metadata (avoids an extra Dubber call); fall
    // back to a live fetch if this call hasn't been synced yet.
    const recording = local || await dubberService.getRecording(req.params.recordingId);

    let transcript = local?.transcript;
    if (!transcript) {
      transcript = await dubberService.getTranscript(req.params.recordingId);
      if (local) {
        await db.execute({ sql: 'UPDATE call_recordings SET transcript = ? WHERE id = ?', args: [transcript, req.params.recordingId] });
      }
    }

    const result = await gradeCall(transcript, rubricType);

    const repName = recording.rep_name || recording.from_label || recording.to_label || recording.channel || null;
    const id = await saveEvaluation({
      recordingId: req.params.recordingId,
      repName,
      callType: recording.call_type,
      rubricType,
      callDate: recording.start_time,
      durationSeconds: recording.duration_seconds ?? recording.duration,
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
