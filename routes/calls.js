const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireSuperAdmin, requireRole } = require('../middleware/authMiddleware');
const dubberService = require('../services/dubberService');
const groqTranscription = require('../services/groqTranscriptionService');
const {
  RUBRICS, gradeCall, gradeManual, saveEvaluation, updateEvaluationResult,
  logEvaluationFeedback, listEvaluationFeedback, detectRubricType,
  addCalibrationNote, listCalibrationNotes, updateCalibrationNote, deleteCalibrationNote,
  getAllEffectiveRubrics, saveRubricInstructions, saveRubricDescription,
  analyzeBenchmarkCalls
} = require('../services/callGradingService');
const { generateReport, answerQuestion } = require('../services/callReportService');
const { extractFaqsFromCall } = require('../services/faqClassifier');
const { v4: uuidv4 } = require('uuid');
const { BUCKETS, uploadBase64, downloadAsBuffer, extForMimetype } = require('../services/storageService');

// Dubber sends start_time with an explicit UTC offset (e.g. "+1000"), and
// dubberService.js normalizes that to a true UTC instant in start_time_iso
// before it's stored, so the raw timestamps are correct. Every date filter
// in this file compares against a plain YYYY-MM-DD picked in the UI against
// a Melbourne calendar, though — so it has to compare the Melbourne calendar
// date the call falls on, not the raw UTC instant, or the boundary shifts by
// up to 11 hours. `AT TIME ZONE` resolves against the real IANA tz database,
// so daylight saving is handled automatically rather than a fixed offset.
const MELBOURNE_TZ = 'Australia/Melbourne';

// Call recordings are confidential, but admins (not just super_admin) get
// full access here — evaluate, delete, and manage rubric/calibration.
// qa_view/workforce_partner also get full access to this router
// (Dashboard/Rubrics/Evaluator is one of the sections both roles are
// explicitly scoped to) — the requireSuperAdmin calls sprinkled below
// (sync, test-connection, extract-faqs, rubric description edits) still
// exclude admin, qa_view, and workforce_partner from those specific
// actions, unchanged.
router.use(requireRole('admin', 'super_admin', 'qa_view', 'workforce_partner'));

// Grading notes should read naturally ("Gelliane handled this well") rather
// than using a rep's full name or a Dubber extension number tacked on
// (rep_name often looks like "Gelliane 299").
function firstNameOnly(name) {
  if (!name) return name;
  return name.trim().split(/\s+/)[0] || name;
}

// Connection status, test connection, and sync are infrastructure-level
// actions (credentials, pulling from Dubber) — restricted to super_admin
// only, unlike the rest of this router which any admin can use.
router.get('/status', requireSuperAdmin, (req, res) => {
  res.json({ dubberConfigured: dubberService.isConfigured(), groqConfigured: groqTranscription.isConfigured() });
});

// Diagnostic step: confirms the connection works and shows the real API
// response shape (including where transcript data actually lives) so the
// grading logic can be built against confirmed data, not a guess.
router.get('/test-connection', requireSuperAdmin, async (req, res) => {
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
router.post('/sync', requireSuperAdmin, async (req, res) => {
  const direction = req.body?.direction === 'older' ? 'older' : 'recent';
  try {
    const result = await dubberService.syncRecordings(direction);
    res.json(result);
  } catch (err) {
    console.error('Dubber sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sync-status', requireSuperAdmin, async (req, res) => {
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
    const { repName, phone, recordingId, callType, dateFrom, dateTo, page = 1, pageSize = 25 } = req.query;
    const conditions = [];
    const args = [];
    if (repName) { conditions.push('rep_name ILIKE ?'); args.push(`%${repName}%`); }
    if (phone) { conditions.push('(to_number ILIKE ? OR from_number ILIKE ?)'); args.push(`%${phone}%`, `%${phone}%`); }
    if (recordingId) { conditions.push('id ILIKE ?'); args.push(`%${recordingId}%`); }
    if (callType === 'inbound' || callType === 'outbound') { conditions.push('call_type = ?'); args.push(callType); }
    // Melbourne calendar date, not the raw UTC instant — see MELBOURNE_TZ.
    if (dateFrom) { conditions.push(`(start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')::date >= ?::date`); args.push(dateFrom); }
    if (dateTo) { conditions.push(`(start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')::date <= ?::date`); args.push(dateTo); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const offset = (Math.max(1, Number(page)) - 1) * Number(pageSize);
    const db = getDb();
    // The list view only needs to know WHETHER a transcript exists (for the
    // "Ready"/badge state) — it doesn't render the transcript text itself
    // (that's fetched separately per-call in the transcript modal). Selecting
    // the full transcript blob for every row on every page load was pure
    // wasted bandwidth/DB read cost.
    const [rows, countRes] = await Promise.all([
      db.execute({
        sql: `SELECT id, to_number, from_number, to_label, from_label, rep_name, call_type, duration_seconds,
                     start_time, start_time_iso, status, sentiment_score, has_audio, content_synced, synced_at,
                     detected_rubric_type, detected_rubric_reasoning,
                     (transcript IS NOT NULL AND transcript != '') AS has_transcript,
                     EXISTS(SELECT 1 FROM call_evaluations ce WHERE ce.recording_id = call_recordings.id) AS evaluated
              FROM call_recordings ${where} ORDER BY start_time_iso DESC LIMIT ? OFFSET ?`,
        args: [...args, Number(pageSize), offset]
      }),
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

// Serves audio that was already fetched and stored at sync time. Supports
// HTTP Range requests (206 Partial Content) — without this, the browser's
// <audio> element can't reliably seek/drag the scrubber, since it has no
// way to fetch just the byte range under the cursor.
router.get('/local/:id/audio', async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM call_recording_audio WHERE recording_id = ?', args: [req.params.id] });
    const row = result.rows[0];
    if (!row || !row.storage_path) return res.status(404).json({ error: 'Audio not synced for this call yet' });
    const buffer = await downloadAsBuffer(BUCKETS.callRecordings, row.storage_path);
    const mimetype = row.mimetype || 'audio/mpeg';
    const total = buffer.length;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimetype);

    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Length', total);
      return res.send(buffer);
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : total - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`);
      return res.end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    res.end(buffer.subarray(start, end + 1));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetches audio + transcript for one call on demand — used from the Browse
// Calls "Fetch Content" action so a specific Pending/Audio-only call doesn't
// have to wait for its turn in the batch Sync pass.
router.post('/:recordingId/fetch-content', async (req, res) => {
  try {
    const db = getDb();
    const localRes = await db.execute({ sql: 'SELECT id, has_audio, transcript FROM call_recordings WHERE id = ?', args: [req.params.recordingId] });
    const local = localRes.rows[0];
    if (!local) return res.status(404).json({ error: 'Call not found in local store — sync it first' });

    const result = await dubberService.fetchContentForRecording(req.params.recordingId, {
      skipAudio: !!local.has_audio,
      existingTranscript: local.transcript
    });

    const updated = await db.execute({
      sql: `SELECT has_audio, (transcript IS NOT NULL AND transcript != '') AS has_transcript FROM call_recordings WHERE id = ?`,
      args: [req.params.recordingId]
    });
    res.json({ ...result, ...updated.rows[0] });
  } catch (err) {
    console.error('Fetch call content error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Classifies a call as Educator-Facing vs Centre-Facing straight from its
// transcript, without grading it — used by the "🔍 Auto-detect" option in
// Browse Calls, and cached on the recording so it's not re-spent later.
router.post('/:recordingId/detect-type', async (req, res) => {
  try {
    const db = getDb();
    const localRes = await db.execute({ sql: 'SELECT id, transcript, detected_rubric_type, detected_rubric_reasoning FROM call_recordings WHERE id = ?', args: [req.params.recordingId] });
    const local = localRes.rows[0];
    if (!local) return res.status(404).json({ error: 'Call not found in local store' });
    if (!local.transcript) return res.status(400).json({ error: 'No transcript available yet — fetch the transcript first' });

    if (local.detected_rubric_type) {
      return res.json({ rubricType: local.detected_rubric_type, reasoning: local.detected_rubric_reasoning, cached: true });
    }

    const detection = await detectRubricType(local.transcript);
    await db.execute({
      sql: 'UPDATE call_recordings SET detected_rubric_type = ?, detected_rubric_reasoning = ? WHERE id = ?',
      args: [detection.rubricType, detection.reasoning, req.params.recordingId]
    });
    res.json({ ...detection, cached: false });
  } catch (err) {
    console.error('Detect call type error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/rubrics', async (req, res) => {
  try {
    res.json(await getAllEffectiveRubrics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-authored, in-depth grading instructions per category — saving
// re-summarises the short reference description via AI and applies the
// instructions to every future AI evaluation for this rubric type.
router.put('/rubrics/:rubricType/:categoryKey/instructions', async (req, res) => {
  if (!RUBRICS[req.params.rubricType]) return res.status(400).json({ error: 'Unknown rubric type' });
  try {
    const result = await saveRubricInstructions(req.params.rubricType, req.params.categoryKey, req.body.instructions || '', req.user.email);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Save rubric instructions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Lets a super_admin hand-edit the short reference description directly,
// bypassing the AI re-summarisation that normally happens when instructions
// are saved. Leaves the in-depth instructions untouched either way.
router.put('/rubrics/:rubricType/:categoryKey/description', requireSuperAdmin, async (req, res) => {
  if (!RUBRICS[req.params.rubricType]) return res.status(400).json({ error: 'Unknown rubric type' });
  const bullets = Array.isArray(req.body.description)
    ? req.body.description.map(x => String(x).trim()).filter(Boolean)
    : String(req.body.description || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (!bullets.length) return res.status(400).json({ error: 'Description cannot be empty' });
  try {
    const result = await saveRubricDescription(req.params.rubricType, req.params.categoryKey, bullets, req.user.email);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Save rubric description error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  const { note, rubricType, categoryKey } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'A note is required' });
  if (rubricType && !RUBRICS[rubricType]) return res.status(400).json({ error: 'Unknown rubric type' });
  try {
    const id = await addCalibrationNote(note.trim(), req.user.email, rubricType || null, categoryKey || null);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/calibration/:id', async (req, res) => {
  const { note } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'A note is required' });
  try {
    await updateCalibrationNote(req.params.id, note.trim());
    res.json({ success: true });
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

// Analyzes a benchmark rep's own calls (defaults to Liam) and turns what
// makes them work into standing calibration notes, the same mechanism
// above — so this is a one-off/occasional spend, not a per-evaluation one.
// super_admin only: it rewrites calibration for the whole team at once.
router.post('/benchmark/analyze', requireSuperAdmin, async (req, res) => {
  try {
    const repName = req.body.repName?.trim() || 'Liam Baxter';
    const result = await analyzeBenchmarkCalls(repName);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Always creates a fresh evaluation — used for grading a call for the first
// time (or deliberately re-running a clean grade). Feedback-driven re-grades
// go through PUT /evaluations/:id/regrade instead, which updates the
// existing evaluation in place rather than adding another one.
router.post('/:recordingId/evaluate', async (req, res) => {
  let { rubricType } = req.body;
  if (!rubricType || (rubricType !== 'auto' && !RUBRICS[rubricType])) {
    return res.status(400).json({ error: 'A valid rubricType ("educator", "centre", or "auto") is required' });
  }
  try {
    const db = getDb();
    const localRes = await db.execute({ sql: 'SELECT * FROM call_recordings WHERE id = ?', args: [req.params.recordingId] });
    const local = localRes.rows[0];

    // Prefer the local cache for metadata (avoids an extra Dubber call); fall
    // back to a live fetch if this call hasn't been synced yet.
    const recording = local || await dubberService.getRecording(req.params.recordingId);

    let transcript = local?.transcript;
    // These ride along with the transcript from Dubber's AI-info endpoint —
    // real audio-derived signal (not inferred from the transcript text).
    // Already on `local` for any call that's been through a normal sync;
    // only fetched fresh below if this call somehow reached evaluation
    // without having gone through fetchContentForRecording first.
    let documentEmotion = local?.document_emotion || null;
    let sentenceEmotion = local?.sentence_emotion || null;
    if (!transcript) {
      // Prefer Dubber's own AI transcript (included in this account's Unified
      // Capture Plus One license) — only fall back to transcribing the audio
      // ourselves via Groq if Dubber's isn't available for this call yet.
      try {
        const aiInfo = await dubberService.getAiInfo(req.params.recordingId);
        transcript = aiInfo.transcript;
        documentEmotion = aiInfo.documentEmotion;
        sentenceEmotion = aiInfo.sentenceEmotion;
      } catch {
        const audioRes = await db.execute({ sql: 'SELECT storage_path, mimetype FROM call_recording_audio WHERE recording_id = ?', args: [req.params.recordingId] });
        const existingAudio = audioRes.rows[0];
        let audioBase64, audioMimetype;
        if (existingAudio?.storage_path) {
          audioMimetype = existingAudio.mimetype || 'audio/mpeg';
          audioBase64 = (await downloadAsBuffer(BUCKETS.callRecordings, existingAudio.storage_path)).toString('base64');
        } else {
          const fetched = await dubberService.downloadRecordingAudio(req.params.recordingId);
          audioMimetype = fetched.mimetype || 'audio/mpeg';
          audioBase64 = fetched.data;
          const path = `${req.params.recordingId}.${extForMimetype(audioMimetype)}`;
          await uploadBase64(BUCKETS.callRecordings, path, audioBase64, audioMimetype);
          await db.execute({
            sql: `INSERT INTO call_recording_audio (recording_id, storage_path, mimetype, filesize) VALUES (?, ?, ?, ?)
                  ON CONFLICT(recording_id) DO UPDATE SET storage_path = excluded.storage_path, mimetype = excluded.mimetype, filesize = excluded.filesize, fetched_at = now()`,
            args: [req.params.recordingId, path, audioMimetype, audioBase64?.length || null]
          });
          if (local) await db.execute({ sql: 'UPDATE call_recordings SET has_audio = true WHERE id = ?', args: [req.params.recordingId] });
        }
        transcript = await groqTranscription.transcribeAudio(audioBase64, audioMimetype);
      }
      if (local) {
        await db.execute({
          sql: 'UPDATE call_recordings SET transcript = ?, document_emotion = ?, sentence_emotion = ? WHERE id = ?',
          args: [transcript, documentEmotion ? JSON.stringify(documentEmotion) : null, sentenceEmotion ? JSON.stringify(sentenceEmotion) : null, req.params.recordingId]
        });
      }
    }

    // "auto" defers to the AI to work out which rubric applies from the
    // transcript, rather than requiring the reviewer to pick one up front.
    // Reuses a cached detection from a prior evaluate/detect call on this
    // recording where possible, so re-evaluating doesn't re-spend an AI call
    // on a question that's already been answered.
    let detectedRubricType = null, detectedRubricReasoning = null;
    if (rubricType === 'auto') {
      if (local?.detected_rubric_type) {
        rubricType = local.detected_rubric_type;
        detectedRubricType = local.detected_rubric_type;
        detectedRubricReasoning = local.detected_rubric_reasoning;
      } else {
        const detection = await detectRubricType(transcript);
        rubricType = detection.rubricType;
        detectedRubricType = detection.rubricType;
        detectedRubricReasoning = detection.reasoning;
        if (local) {
          await db.execute({
            sql: 'UPDATE call_recordings SET detected_rubric_type = ?, detected_rubric_reasoning = ? WHERE id = ?',
            args: [detection.rubricType, detection.reasoning, req.params.recordingId]
          });
        }
      }
    }

    const repName = firstNameOnly(recording.rep_name || recording.from_label || recording.to_label || recording.channel || null);
    const result = await gradeCall(transcript, rubricType, repName, {
      sentimentScore: recording.sentiment_score ?? null,
      documentEmotion,
      sentenceEmotion
    });

    const id = await saveEvaluation({
      recordingId: req.params.recordingId,
      repName,
      callType: recording.call_type,
      rubricType,
      callDate: recording.start_time,
      durationSeconds: recording.duration_seconds ?? recording.duration,
      result,
      evaluatedBy: req.user.email,
      source: 'ai'
    });

    res.json({ id, repName, rubricType, source: 'ai', detectedRubricType, detectedRubricReasoning, ...result });
  } catch (err) {
    console.error('Call evaluation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Re-grades an EXISTING evaluation in place — the reviewer is having a
// conversation with the AI about one specific call, not creating a new
// call each time they give feedback. Updates that evaluation's scores/
// notes/outcome, logs this round of feedback to the append-only history
// (so nothing is lost across any number of re-grades), and — same as
// before — saves the feedback as a standing calibration rule so it also
// shapes every future grading run for this rubric/category.
router.put('/evaluations/:id/regrade', async (req, res) => {
  // Each item is one reviewer comment tied to exactly one category (or to
  // "General" if categoryKey is null/omitted) — the progressive-dropdown UI
  // on the client submits one item per row it built up.
  const items = Array.isArray(req.body.items)
    ? req.body.items
        .map(it => ({ categoryKey: it?.categoryKey || null, feedbackText: (it?.feedbackText || '').trim() }))
        .filter(it => it.feedbackText)
    : [];
  if (!items.length) return res.status(400).json({ error: 'Feedback is required to re-grade' });
  try {
    const db = getDb();
    const evalRes = await db.execute({ sql: 'SELECT * FROM call_evaluations WHERE id = ?', args: [req.params.id] });
    const evaluation = evalRes.rows[0];
    if (!evaluation) return res.status(404).json({ error: 'Evaluation not found' });

    const localRes = await db.execute({ sql: 'SELECT transcript, sentiment_score, document_emotion, sentence_emotion FROM call_recordings WHERE id = ?', args: [evaluation.recording_id] });
    const local = localRes.rows[0];
    if (!local?.transcript) return res.status(400).json({ error: 'No transcript available for this call' });

    // Passing the CURRENT result lets the model build on top of every prior
    // re-grade instead of re-deriving the whole call from the transcript
    // again — categories this round's feedback doesn't touch are carried
    // forward unchanged, so an earlier round's correction never gets
    // silently undone by a later, unrelated one.
    const currentResult = { categoryScores: evaluation.category_scores, summary: evaluation.summary };
    const result = await gradeCall(local.transcript, evaluation.rubric_type, evaluation.rep_name, {
      feedbackItems: items,
      sentimentScore: local.sentiment_score ?? null,
      documentEmotion: local.document_emotion || null,
      sentenceEmotion: local.sentence_emotion || null,
      currentResult
    });

    const rubric = RUBRICS[evaluation.rubric_type];
    const combinedFeedback = items.map(item => {
      const cat = item.categoryKey ? rubric?.categories.find(c => c.key === item.categoryKey) : null;
      return `${cat ? cat.label : 'General'}: ${item.feedbackText}`;
    }).join('\n');
    const combinedCategoryKeys = items.map(item => item.categoryKey).filter(Boolean);

    await updateEvaluationResult(evaluation.id, {
      result,
      reviewerFeedback: combinedFeedback,
      reviewerFeedbackCategories: combinedCategoryKeys
    });

    // One history row and one standing calibration note per item, so each
    // category-specific correction is logged and applied to future grading
    // separately rather than merged into a single ambiguous blob.
    for (const item of items) {
      await logEvaluationFeedback(evaluation.id, item.feedbackText, item.categoryKey ? [item.categoryKey] : [], req.user.email);
      await addCalibrationNote(item.feedbackText, req.user.email, evaluation.rubric_type, item.categoryKey || null);
    }

    res.json({ id: evaluation.id, repName: evaluation.rep_name, rubricType: evaluation.rubric_type, source: 'ai', ...result });
  } catch (err) {
    console.error('Call re-grade error:', err.message);
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
    const repName = firstNameOnly(recording.rep_name || recording.from_label || recording.to_label || recording.channel || null);
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

// Recent Evaluations list on the Call Quality Evaluator page — paginated
// and filterable (date/evaluator/rubric type/outcome), same shape as
// GET /local's page/pageSize/total contract. dateFrom/dateTo compare the
// Melbourne calendar date the evaluation was created on, matching every
// other date filter in this file (see MELBOURNE_TZ above).
router.get('/evaluations', async (req, res) => {
  try {
    const { page = 1, pageSize = 20, dateFrom, dateTo, evaluatedBy, rubricType, outcome } = req.query;
    const conditions = [];
    const args = [];
    if (dateFrom) { conditions.push(`(created_at AT TIME ZONE '${MELBOURNE_TZ}')::date >= ?::date`); args.push(dateFrom); }
    if (dateTo) { conditions.push(`(created_at AT TIME ZONE '${MELBOURNE_TZ}')::date <= ?::date`); args.push(dateTo); }
    if (evaluatedBy) { conditions.push('evaluated_by = ?'); args.push(evaluatedBy); }
    if (rubricType && RUBRICS[rubricType]) { conditions.push('rubric_type = ?'); args.push(rubricType); }
    if (outcome) { conditions.push('outcome = ?'); args.push(outcome); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const offset = (Math.max(1, Number(page)) - 1) * Number(pageSize);
    const db = getDb();
    const [rows, countRes] = await Promise.all([
      db.execute({ sql: `SELECT * FROM call_evaluations ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, args: [...args, Number(pageSize), offset] }),
      db.execute({ sql: `SELECT COUNT(*) AS n FROM call_evaluations ${where}`, args })
    ]);
    res.json({ evaluations: rows.rows, total: Number(countRes.rows[0].n), page: Number(page), pageSize: Number(pageSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Distinct evaluated_by values (real data is currently email addresses,
// e.g. joy@rawtalent.com.au — no separate display-name mapping exists for
// this field) for the Recent Evaluations Evaluator filter dropdown, same
// pattern as /rep-names above.
router.get('/evaluated-by', async (req, res) => {
  try {
    const result = await getDb().execute("SELECT DISTINCT evaluated_by FROM call_evaluations WHERE evaluated_by IS NOT NULL ORDER BY evaluated_by");
    res.json(result.rows.map(r => r.evaluated_by));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pulls a call's transcript and asks Claude to find genuinely reusable FAQ
// material in it — each becomes a normal pending candidate in the same
// review queue Slack/Fathom/document scans feed, so nothing reaches the
// knowledge base without a human approving it. Super_admin only, matching
// every other FAQ-candidate source.
router.post('/:recordingId/extract-faqs', requireSuperAdmin, async (req, res) => {
  try {
    const db = getDb();
    const localRes = await db.execute({ sql: 'SELECT id, rep_name, start_time, transcript FROM call_recordings WHERE id = ?', args: [req.params.recordingId] });
    const local = localRes.rows[0];
    if (!local) return res.status(404).json({ error: 'Call not found in local store' });
    if (!local.transcript?.trim()) return res.status(400).json({ error: 'No transcript available for this call yet' });

    const callContext = `a call on ${local.start_time || 'an unknown date'}`;
    const { candidates } = await extractFaqsFromCall(local.transcript, callContext);

    let candidatesFound = 0;
    for (const c of candidates) {
      if (!c.question?.trim() || !c.answer?.trim()) continue;
      const id = uuidv4();
      await db.execute({
        sql: `INSERT INTO faq_candidates
              (id, source, source_ref, source_date, raw_excerpt, suggested_question, suggested_answer, classification_reason)
              VALUES (?, 'call', ?, ?, ?, ?, ?, ?)`,
        args: [id, req.params.recordingId, local.start_time || null, local.transcript.slice(0, 2000), c.question.trim(), c.answer.trim(), 'Extracted from a call transcript']
      });
      candidatesFound++;
    }
    res.json({ candidatesFound });
  } catch (err) {
    console.error('Call FAQ extraction error:', err.message);
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

// Shared by /report and /ask — both need the same filtered, period-bounded
// set of evaluations (joined to call_recordings for a reliable ISO date to
// filter on) as their evidence base.
async function fetchFilteredEvaluations({ dateFrom, dateTo, repName, rubricType }) {
  // "calibration_only"/"calibration_done" evaluations are deliberately
  // excluded from every quality-score/aggregate view (Dashboard report,
  // Q&A, and any future rep-facing dashboard that reuses this) — they
  // exist purely to review calls and train the AI grader, and must never
  // count against a rep. "Done" is just the reviewed/processed state of
  // the same calibration-only status, not a real quality outcome.
  const conditions = ["e.outcome NOT IN ('calibration_only', 'calibration_done')"];
  const args = [];
  // Melbourne calendar date, not the raw UTC instant — see MELBOURNE_TZ.
  if (dateFrom) { conditions.push(`(r.start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')::date >= ?::date`); args.push(dateFrom); }
  if (dateTo) { conditions.push(`(r.start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')::date <= ?::date`); args.push(dateTo); }
  if (repName) { conditions.push('e.rep_name = ?'); args.push(repName); }
  if (rubricType && RUBRICS[rubricType]) { conditions.push('e.rubric_type = ?'); args.push(rubricType); }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const result = await getDb().execute({
    sql: `SELECT e.* FROM call_evaluations e LEFT JOIN call_recordings r ON r.id = e.recording_id ${where} ORDER BY e.created_at DESC LIMIT 500`,
    args
  });
  return result.rows;
}

// Call Quality Dashboard — aggregates evaluations within a period and, if
// configured, asks Claude for a narrative report: team/individual
// performance against the rubric, outliers worth addressing, and
// commendable behaviour.
router.get('/report', async (req, res) => {
  const { dateFrom, dateTo, repName, rubricType, category } = req.query;
  try {
    const evaluations = await fetchFilteredEvaluations({ dateFrom, dateTo, repName, rubricType });
    const report = await generateReport(evaluations, { rubricType, category });
    res.json(report);
  } catch (err) {
    console.error('Call report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Free-form Q&A against the same period the dashboard is currently showing —
// "how did Vicky do this month", "any compliance concerns in July", etc.
router.post('/ask', async (req, res) => {
  const { dateFrom, dateTo, repName, rubricType, category, question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'A question is required' });
  try {
    const evaluations = await fetchFilteredEvaluations({ dateFrom, dateTo, repName, rubricType });
    const answer = await answerQuestion(evaluations, { rubricType, category }, question.trim());
    res.json({ answer });
  } catch (err) {
    console.error('Call quality Q&A error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Raw call volume (from Dubber's synced metadata, not evaluations) —
// inbound/outbound counts and a per-period trend, filterable by rep and
// date range, with the grouping granularity chosen by the caller. All
// date/time bucketing is in Melbourne local time (see MELBOURNE_TZ above).
router.get('/volume-stats', async (req, res) => {
  const { repName, callType, dateFrom, dateTo } = req.query;
  const groupBy = ['day', 'week', 'month'].includes(req.query.groupBy) ? req.query.groupBy : 'month';
  try {
    const conditions = ['start_time_iso IS NOT NULL'];
    const args = [];
    if (repName) { conditions.push('rep_name ILIKE ?'); args.push(`%${repName}%`); }
    if (callType === 'inbound' || callType === 'outbound') { conditions.push('call_type = ?'); args.push(callType); }
    // dateFrom/dateTo are plain YYYY-MM-DD dates picked against a Melbourne
    // calendar, so compare them against the Melbourne calendar date the
    // call actually falls on — not the raw UTC instant, which would shift
    // the boundary by up to 11 hours.
    if (dateFrom) { conditions.push(`(start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')::date >= ?::date`); args.push(dateFrom); }
    if (dateTo) { conditions.push(`(start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')::date <= ?::date`); args.push(dateTo); }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const db = getDb();
    const [totalsRes, byRepRes, byPeriodRes, byDowRes, byHourRes] = await Promise.all([
      db.execute({
        sql: `SELECT COUNT(*) AS total,
                     COUNT(*) FILTER (WHERE call_type = 'inbound') AS inbound,
                     COUNT(*) FILTER (WHERE call_type = 'outbound') AS outbound
              FROM call_recordings ${where}`,
        args
      }),
      db.execute({
        sql: `SELECT rep_name,
                     COUNT(*) AS total,
                     COUNT(*) FILTER (WHERE call_type = 'inbound') AS inbound,
                     COUNT(*) FILTER (WHERE call_type = 'outbound') AS outbound
              FROM call_recordings ${where}
              GROUP BY rep_name ORDER BY total DESC LIMIT 50`,
        args
      }),
      db.execute({
        sql: `SELECT to_char(date_trunc('${groupBy}', start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}'), 'YYYY-MM-DD') AS period,
                     COUNT(*) AS total,
                     COUNT(*) FILTER (WHERE call_type = 'inbound') AS inbound,
                     COUNT(*) FILTER (WHERE call_type = 'outbound') AS outbound
              FROM call_recordings ${where}
              GROUP BY period ORDER BY period ASC`,
        args
      }),
      // Day-of-week trend — independent of the groupBy above (which
      // collapses to week/month), so this always answers "which weekdays
      // run busiest" over the filtered range. days_observed counts the
      // distinct calendar dates that fell on each weekday and had at least
      // one call, so total/days_observed gives a fair per-weekday average
      // rather than a raw total that's skewed by how many of each weekday
      // happen to fall in the selected range.
      db.execute({
        sql: `SELECT EXTRACT(ISODOW FROM start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')::int AS dow,
                     COUNT(*) AS total,
                     COUNT(*) FILTER (WHERE call_type = 'inbound') AS inbound,
                     COUNT(*) FILTER (WHERE call_type = 'outbound') AS outbound,
                     COUNT(DISTINCT date_trunc('day', start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')) AS days_observed
              FROM call_recordings ${where}
              GROUP BY dow ORDER BY dow ASC`,
        args
      }),
      // Hour-of-day trend (0-23, Melbourne local) — same per-day-observed
      // averaging as the weekday chart, so a hot 9am is comparable to a hot
      // 2pm even if the date range doesn't cover every hour evenly.
      db.execute({
        sql: `SELECT EXTRACT(HOUR FROM start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')::int AS hour,
                     COUNT(*) AS total,
                     COUNT(*) FILTER (WHERE call_type = 'inbound') AS inbound,
                     COUNT(*) FILTER (WHERE call_type = 'outbound') AS outbound,
                     COUNT(DISTINCT date_trunc('day', start_time_iso::timestamptz AT TIME ZONE '${MELBOURNE_TZ}')) AS days_observed
              FROM call_recordings ${where}
              GROUP BY hour ORDER BY hour ASC`,
        args
      })
    ]);

    res.json({
      total: Number(totalsRes.rows[0]?.total || 0),
      inbound: Number(totalsRes.rows[0]?.inbound || 0),
      outbound: Number(totalsRes.rows[0]?.outbound || 0),
      byRep: byRepRes.rows.map(r => ({ repName: r.rep_name || 'Unknown', total: Number(r.total), inbound: Number(r.inbound), outbound: Number(r.outbound) })),
      byPeriod: byPeriodRes.rows.map(r => ({ period: r.period, total: Number(r.total), inbound: Number(r.inbound), outbound: Number(r.outbound) })),
      byDow: byDowRes.rows.map(r => ({ dow: r.dow, total: Number(r.total), inbound: Number(r.inbound), outbound: Number(r.outbound), daysObserved: Number(r.days_observed) })),
      byHour: byHourRes.rows.map(r => ({ hour: r.hour, total: Number(r.total), inbound: Number(r.inbound), outbound: Number(r.outbound), daysObserved: Number(r.days_observed) })),
      groupBy,
      timezone: MELBOURNE_TZ
    });
  } catch (err) {
    console.error('Call volume stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/evaluations/:id', async (req, res) => {
  try {
    // Joined to call_recordings for the contact number and whether audio/
    // transcript are actually available — the evaluation itself never
    // stored any of this, so this is the only way to show it (and offer
    // Play/View Transcript) in the detail view.
    const result = await getDb().execute({
      sql: `SELECT e.*, r.to_number, r.from_number, r.has_audio,
                   (r.transcript IS NOT NULL AND r.transcript != '') AS has_transcript
            FROM call_evaluations e
            LEFT JOIN call_recordings r ON r.id = e.recording_id WHERE e.id = ?`,
      args: [req.params.id]
    });
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Evaluation not found' });
    // Full re-grade conversation thread — every round of feedback ever given
    // on this evaluation, oldest first, regardless of how many times it's
    // been re-graded.
    const feedbackHistory = await listEvaluationFeedback(row.id);
    res.json({ ...row, feedbackHistory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lets a reviewer override the recommendation an evaluation landed on —
// including flagging it "calibration_only" (or, once reviewed,
// "calibration_done"), both of which exclude it from every rep-facing/
// aggregate quality view (see fetchFilteredEvaluations) without deleting
// the evaluation itself, since it's still useful for training the AI
// grader.
const RECOMMENDATION_OUTCOMES = ['pass', 'coaching', 'escalate', 'calibration_only', 'calibration_done'];
router.put('/evaluations/:id/outcome', async (req, res) => {
  const { outcome } = req.body;
  if (!RECOMMENDATION_OUTCOMES.includes(outcome)) {
    return res.status(400).json({ error: `outcome must be one of: ${RECOMMENDATION_OUTCOMES.join(', ')}` });
  }
  try {
    const result = await getDb().execute({ sql: 'UPDATE call_evaluations SET outcome = ? WHERE id = ?', args: [outcome, req.params.id] });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Evaluation not found' });
    res.json({ success: true, outcome });
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
