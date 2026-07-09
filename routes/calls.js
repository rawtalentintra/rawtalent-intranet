const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const dubberService = require('../services/dubberService');
const groqTranscription = require('../services/groqTranscriptionService');
const { RUBRICS, gradeCall, gradeManual, saveEvaluation, addCalibrationNote, listCalibrationNotes, deleteCalibrationNote } = require('../services/callGradingService');
const { generateReport } = require('../services/callReportService');

// Call recordings are confidential — everything here is super_admin only,
// same as the FAQ Review / Slack+Fathom review queue.
router.use(requireSuperAdmin);

router.get('/status', (req, res) => {
  res.json({ dubberConfigured: dubberService.isConfigured(), groqConfigured: groqTranscription.isConfigured() });
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

// Standing grading calibration — a running list of corrections a reviewer
// has taught the AI, applied to every future evaluation regardless of call
// or rep. Manageable directly here in case a note turns out to be wrong.
router.get('/calibration', async (req, res) => {
  try {
    res.json(await listCalibrationNotes());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/calibration', async (req, res) => {
  const { note } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'A note is required' });
  try {
    const id = await addCalibrationNote(note.trim(), req.user.email);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/calibration/:id', async (req, res) => {
  try {
    await deleteCalibrationNote(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:recordingId/evaluate', async (req, res) => {
  const { rubricType, feedback } = req.body;
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
      // Prefer Dubber's own AI transcript (included in this account's Unified
      // Capture Plus One license) — only fall back to transcribing the audio
      // ourselves via Groq if Dubber's isn't available for this call yet.
      try {
        transcript = await dubberService.getTranscript(req.params.recordingId);
      } catch {
        let audioRes = await db.execute({ sql: 'SELECT data, mimetype FROM call_recording_audio WHERE recording_id = ?', args: [req.params.recordingId] });
        let audio = audioRes.rows[0];
        if (!audio) {
          const fetched = await dubberService.downloadRecordingAudio(req.params.recordingId);
          audio = { data: fetched.data, mimetype: fetched.mimetype };
          await db.execute({
            sql: `INSERT INTO call_recording_audio (recording_id, data, mimetype, filesize) VALUES (?, ?, ?, ?)
                  ON CONFLICT(recording_id) DO UPDATE SET data = excluded.data, mimetype = excluded.mimetype, filesize = excluded.filesize, fetched_at = datetime('now')`,
            args: [req.params.recordingId, audio.data, audio.mimetype || 'audio/mpeg', audio.data?.length || null]
          });
          if (local) await db.execute({ sql: 'UPDATE call_recordings SET has_audio = 1 WHERE id = ?', args: [req.params.recordingId] });
        }
        transcript = await groqTranscription.transcribeAudio(audio.data, audio.mimetype);
      }
      if (local) {
        await db.execute({ sql: 'UPDATE call_recordings SET transcript = ? WHERE id = ?', args: [transcript, req.params.recordingId] });
      }
    }

    const result = await gradeCall(transcript, rubricType, feedback || null);

    // Feedback given on this call is also saved as a standing calibration
    // note, so every future AI grading run (any call, any rep) applies the
    // same correction — not just this one re-grade.
    if (feedback?.trim()) {
      await addCalibrationNote(feedback.trim(), req.user.email);
    }

    const repName = recording.rep_name || recording.from_label || recording.to_label || recording.channel || null;
    const id = await saveEvaluation({
      recordingId: req.params.recordingId,
      repName,
      callType: recording.call_type,
      rubricType,
      callDate: recording.start_time,
      durationSeconds: recording.duration_seconds ?? recording.duration,
      result,
      evaluatedBy: req.user.email,
      source: 'ai',
      reviewerFeedback: feedback?.trim() || null
    });

    res.json({ id, repName, rubricType, source: 'ai', calibrationSaved: !!feedback?.trim(), ...result });
  } catch (err) {
    console.error('Call evaluation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Human grading via the manual form — reuses the same rubric weighting/
// zero-tolerance logic as the AI path so scores stay comparable.
router.post('/:recordingId/evaluate-manual', async (req, res) => {
  const { rubricType, scores, summary } = req.body;
  if (!rubricType || !RUBRICS[rubricType]) {
    return res.status(400).json({ error: 'A valid rubricType ("educator" or "centre") is required' });
  }
  if (!Array.isArray(scores) || scores.length === 0) {
    return res.status(400).json({ error: 'scores must be a non-empty array of {key, score, notes}' });
  }
  const validKeys = new Set(RUBRICS[rubricType].categories.map(c => c.key));
  for (const s of scores) {
    if (!validKeys.has(s.key)) return res.status(400).json({ error: `Unknown category key: ${s.key}` });
    const n = Number(s.score);
    if (!Number.isInteger(n) || n < 1 || n > 5) return res.status(400).json({ error: `Score for ${s.key} must be an integer 1-5` });
  }
  try {
    const db = getDb();
    const localRes = await db.execute({ sql: 'SELECT * FROM call_recordings WHERE id = ?', args: [req.params.recordingId] });
    const local = localRes.rows[0];
    const recording = local || await dubberService.getRecording(req.params.recordingId);

    const result = gradeManual(rubricType, scores, summary);
    const repName = recording.rep_name || recording.from_label || recording.to_label || recording.channel || null;
    const id = await saveEvaluation({
      recordingId: req.params.recordingId,
      repName,
      callType: recording.call_type,
      rubricType,
      callDate: recording.start_time,
      durationSeconds: recording.duration_seconds ?? recording.duration,
      result,
      evaluatedBy: req.user.email,
      source: 'human'
    });

    res.json({ id, repName, rubricType, source: 'human', ...result });
  } catch (err) {
    console.error('Manual call evaluation error:', err.message);
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

router.get('/rep-names', async (req, res) => {
  try {
    const result = await getDb().execute("SELECT DISTINCT rep_name FROM call_evaluations WHERE rep_name IS NOT NULL ORDER BY rep_name");
    res.json(result.rows.map(r => r.rep_name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Call Quality Dashboard — aggregates evaluations within a period (joined to
// call_recordings for a reliable ISO date to filter on) and, if configured,
// asks Claude for a narrative report: team/individual performance against
// the rubric, outliers worth addressing, and commendable behaviour.
router.get('/report', async (req, res) => {
  const { dateFrom, dateTo, repName, rubricType, category } = req.query;
  try {
    const conditions = [];
    const args = [];
    if (dateFrom) { conditions.push('r.start_time_iso >= ?'); args.push(new Date(dateFrom).toISOString()); }
    if (dateTo) { conditions.push('r.start_time_iso <= ?'); args.push(new Date(dateTo).toISOString()); }
    if (repName) { conditions.push('e.rep_name = ?'); args.push(repName); }
    if (rubricType && RUBRICS[rubricType]) { conditions.push('e.rubric_type = ?'); args.push(rubricType); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await getDb().execute({
      sql: `SELECT e.* FROM call_evaluations e LEFT JOIN call_recordings r ON r.id = e.recording_id ${where} ORDER BY e.created_at DESC LIMIT 500`,
      args
    });
    const evaluations = result.rows.map(r => ({ ...r, category_scores: JSON.parse(r.category_scores) }));
    const report = await generateReport(evaluations, { rubricType, category });
    res.json(report);
  } catch (err) {
    console.error('Call report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/evaluations/:id', async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM call_evaluations WHERE id = ?', args: [req.params.id] });
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Evaluation not found' });
    res.json({ ...row, category_scores: JSON.parse(row.category_scores) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/evaluations/:id', async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'DELETE FROM call_evaluations WHERE id = ?', args: [req.params.id] });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Evaluation not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
