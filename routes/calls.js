const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
const dubberService = require('../services/dubberService');
const groqTranscription = require('../services/groqTranscriptionService');
const {
  RUBRICS, gradeCall, gradeManual, saveEvaluation, updateEvaluationResult,
  logEvaluationFeedback, listEvaluationFeedback, detectRubricType,
  addCalibrationNote, listCalibrationNotes, deleteCalibrationNote,
  getAllEffectiveRubrics, saveRubricInstructions, saveRubricDescription
} = require('../services/callGradingService');
const { generateReport, answerQuestion } = require('../services/callReportService');
const { extractFaqsFromCall } = require('../services/faqClassifier');
const { v4: uuidv4 } = require('uuid');
const { BUCKETS, uploadBase64, downloadAsBuffer, extForMimetype } = require('../services/storageService');

// Call recordings are confidential, but admins (not just super_admin) get
// full access here — evaluate, delete, and manage rubric/calibration.
router.use(requireAdmin);

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
    const { repName, phone, recordingId, dateFrom, dateTo, page = 1, pageSize = 25 } = req.query;
    const conditions = [];
    const args = [];
    if (repName) { conditions.push('rep_name LIKE ?'); args.push(`%${repName}%`); }
    if (phone) { conditions.push('(to_number LIKE ? OR from_number LIKE ?)'); args.push(`%${phone}%`, `%${phone}%`); }
    if (recordingId) { conditions.push('id LIKE ?'); args.push(`%${recordingId}%`); }
    if (dateFrom) { conditions.push('start_time_iso >= ?'); args.push(new Date(dateFrom).toISOString()); }
    if (dateTo) { conditions.push('start_time_iso <= ?'); args.push(new Date(dateTo).toISOString()); }
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
                     (transcript IS NOT NULL AND transcript != '') AS has_transcript
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

// Serves audio that was already fetched and stored at sync time.
router.get('/local/:id/audio', async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM call_recording_audio WHERE recording_id = ?', args: [req.params.id] });
    const row = result.rows[0];
    if (!row || !row.storage_path) return res.status(404).json({ error: 'Audio not synced for this call yet' });
    const buffer = await downloadAsBuffer(BUCKETS.callRecordings, row.storage_path);
    res.setHeader('Content-Type', row.mimetype || 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
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

router.delete('/calibration/:id', async (req, res) => {
  try {
    await deleteCalibrationNote(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    if (!transcript) {
      // Prefer Dubber's own AI transcript (included in this account's Unified
      // Capture Plus One license) — only fall back to transcribing the audio
      // ourselves via Groq if Dubber's isn't available for this call yet.
      try {
        transcript = await dubberService.getTranscript(req.params.recordingId);
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
        await db.execute({ sql: 'UPDATE call_recordings SET transcript = ? WHERE id = ?', args: [transcript, req.params.recordingId] });
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
    const result = await gradeCall(transcript, rubricType, repName, { sentimentScore: recording.sentiment_score ?? null });

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

    const localRes = await db.execute({ sql: 'SELECT transcript, sentiment_score FROM call_recordings WHERE id = ?', args: [evaluation.recording_id] });
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

router.get('/evaluations', async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM call_evaluations ORDER BY created_at DESC LIMIT 200');
    res.json(result.rows);
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
  // "calibration_only" evaluations are deliberately excluded from every
  // quality-score/aggregate view (Dashboard report, Q&A, and any future
  // rep-facing dashboard that reuses this) — they exist purely to review
  // calls and train the AI grader, and must never count against a rep.
  const conditions = ["e.outcome != 'calibration_only'"];
  const args = [];
  if (dateFrom) { conditions.push('r.start_time_iso >= ?'); args.push(new Date(dateFrom).toISOString()); }
  if (dateTo) { conditions.push('r.start_time_iso <= ?'); args.push(new Date(dateTo).toISOString()); }
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
// date range, with the grouping granularity chosen by the caller.
router.get('/volume-stats', async (req, res) => {
  const { repName, callType, dateFrom, dateTo } = req.query;
  const groupBy = ['day', 'week', 'month'].includes(req.query.groupBy) ? req.query.groupBy : 'month';
  try {
    const conditions = ['start_time_iso IS NOT NULL'];
    const args = [];
    if (repName) { conditions.push('rep_name ILIKE ?'); args.push(`%${repName}%`); }
    if (callType === 'inbound' || callType === 'outbound') { conditions.push('call_type = ?'); args.push(callType); }
    if (dateFrom) { conditions.push('start_time_iso >= ?'); args.push(new Date(dateFrom).toISOString()); }
    if (dateTo) { conditions.push('start_time_iso <= ?'); args.push(new Date(dateTo).toISOString()); }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const db = getDb();
    const [totalsRes, byRepRes, byPeriodRes] = await Promise.all([
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
        sql: `SELECT to_char(date_trunc('${groupBy}', start_time_iso::timestamptz), 'YYYY-MM-DD') AS period,
                     COUNT(*) AS total,
                     COUNT(*) FILTER (WHERE call_type = 'inbound') AS inbound,
                     COUNT(*) FILTER (WHERE call_type = 'outbound') AS outbound
              FROM call_recordings ${where}
              GROUP BY period ORDER BY period ASC`,
        args
      })
    ]);

    res.json({
      total: Number(totalsRes.rows[0]?.total || 0),
      inbound: Number(totalsRes.rows[0]?.inbound || 0),
      outbound: Number(totalsRes.rows[0]?.outbound || 0),
      byRep: byRepRes.rows.map(r => ({ repName: r.rep_name || 'Unknown', total: Number(r.total), inbound: Number(r.inbound), outbound: Number(r.outbound) })),
      byPeriod: byPeriodRes.rows.map(r => ({ period: r.period, total: Number(r.total), inbound: Number(r.inbound), outbound: Number(r.outbound) })),
      groupBy
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
// including flagging it "calibration_only", which excludes it from every
// rep-facing/aggregate quality view (see fetchFilteredEvaluations) without
// deleting the evaluation itself, since it's still useful for training the
// AI grader.
const RECOMMENDATION_OUTCOMES = ['pass', 'coaching', 'escalate', 'calibration_only'];
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
