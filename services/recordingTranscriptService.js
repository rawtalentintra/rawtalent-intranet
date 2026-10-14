// Transcripts for the voice notes / recordings partners attach to leads and
// centres. Until 2026-10-12 a transcript only existed for a moment, as a
// suggested note in the modal — if nobody tapped "Add Note" the content was
// lost. Now each audio recording's transcript and a short summary are stored
// on its own row in Supabase (lead_recordings / centre_recordings), filled in
// by a background job so any new recording is picked up within minutes.
// Only reads the stored audio and writes the transcript columns — it never
// touches the audio file, the lead, or its notes.
const { getDb } = require('../db/database');
const { BUCKETS, downloadAsBuffer } = require('./storageService');
const groq = require('./groqTranscriptionService');
const { analyzeVisitFromTranscript } = require('./centreVisitAnalysisService');

const KINDS = {
  lead: {
    table: 'lead_recordings', bucket: () => BUCKETS.leadRecordings,
    nameSql: '(SELECT centre_name FROM leads WHERE leads.id = r.lead_id)'
  },
  centre: {
    table: 'centre_recordings', bucket: () => BUCKETS.centreRecordings,
    nameSql: 'NULL'
  }
};
const { v4: uuidv4 } = require('uuid');
const VOICE_VISIT_NOTE = 'Logged from voice recording';
const MIN_WORDS = 8; // a real visit note, not "Thank you" or an empty file

// A voice note on a lead means the partner was at the centre (Joy, 2026-10-14):
// if the lead isn't marked Visited yet, mark it, dated when the recording was
// made, and credit the visit to whoever recorded it. Only when the transcript
// has real content. HeartBeat data only — nothing goes to RT.
async function markLeadVisitedFromRecording(recordingId) {
  const db = getDb();
  const r = (await db.execute({
    sql: `SELECT r.id, r.lead_id, r.created_at, r.uploaded_by_email, r.uploaded_by_name, r.transcript, l.centre_visited_status
          FROM lead_recordings r JOIN leads l ON l.id = r.lead_id WHERE r.id = ?`,
    args: [recordingId]
  })).rows[0];
  if (!r || r.centre_visited_status === 'done') return false;
  if (String(r.transcript || '').trim().split(/\s+/).filter(Boolean).length < MIN_WORDS) return false;
  await db.execute({
    sql: `UPDATE leads SET centre_visited_status = 'done', centre_visited_at = ?,
                 lead_called_status = CASE WHEN lead_called_status = 'to_schedule' THEN 'n_a' ELSE lead_called_status END,
                 updated_at = now()
          WHERE id = ? AND centre_visited_status IS DISTINCT FROM 'done'`,
    args: [r.created_at, r.lead_id]
  });
  await db.execute({
    sql: `INSERT INTO lead_activities (id, lead_id, channel, notes, created_by_email, created_by_name, created_at)
          VALUES (?, ?, 'visit', ?, ?, ?, ?)`,
    args: [uuidv4(), r.lead_id, VOICE_VISIT_NOTE, r.uploaded_by_email, r.uploaded_by_name || r.uploaded_by_email, r.created_at]
  });
  return true;
}

// Runs the rule above over every transcribed lead recording (for recordings
// made before this existed). Safe to re-run: a lead already Visited is skipped.
async function markVisitsFromExistingRecordings() {
  const ids = (await getDb().execute({ sql: 'SELECT id FROM lead_recordings WHERE transcript IS NOT NULL ORDER BY created_at', args: [] })).rows.map(x => x.id);
  let marked = 0;
  for (const id of ids) if (await markLeadVisitedFromRecording(id)) marked++;
  return marked;
}

const MAX_BYTES = 24 * 1024 * 1024; // Groq's upload limit is 25MB
let running = false;

async function transcribeOne(kind, row) {
  const k = KINDS[kind];
  const db = getDb();
  try {
    const buffer = await downloadAsBuffer(k.bucket(), row.storage_path);
    if (buffer.length > MAX_BYTES) throw new Error('File is too large to transcribe (over 24MB)');
    const transcript = await groq.transcribeAudio(buffer.toString('base64'), row.mimetype);
    const analysis = await analyzeVisitFromTranscript(transcript, row.centre_name);
    await db.execute({
      sql: `UPDATE ${k.table} SET transcript = ?, summary = ?, transcribed_at = now(), transcription_error = NULL WHERE id = ?`,
      args: [transcript, analysis.notesSummary, row.id]
    });
    if (kind === 'lead') await markLeadVisitedFromRecording(row.id).catch(err => console.error('Voice-recording visit credit failed:', err.message));
    return true;
  } catch (err) {
    await db.execute({ sql: `UPDATE ${k.table} SET transcription_error = ? WHERE id = ?`, args: [String(err.message).slice(0, 300), row.id] });
    console.error(`Recording transcription failed (${kind} ${row.id}):`, err.message);
    return false;
  }
}

// Transcribes up to `limit` audio/video recordings that have no transcript
// yet and no earlier failure (a failed one is left alone — clear its
// transcription_error to retry it).
async function transcribePending(limit = 10) {
  if (!groq.isConfigured() || running) return { done: 0, failed: 0 };
  running = true;
  let done = 0, failed = 0;
  try {
    const db = getDb();
    for (const kind of Object.keys(KINDS)) {
      const k = KINDS[kind];
      const rows = (await db.execute({
        sql: `SELECT r.id, r.storage_path, r.mimetype, ${k.nameSql} AS centre_name FROM ${k.table} r
              WHERE r.transcript IS NULL AND r.transcription_error IS NULL AND r.storage_path IS NOT NULL
                AND (r.mimetype LIKE 'audio/%' OR r.mimetype LIKE 'video/%')
              ORDER BY r.created_at LIMIT ?`,
        args: [limit]
      })).rows;
      for (const row of rows) { (await transcribeOne(kind, row)) ? done++ : failed++; }
    }
  } finally { running = false; }
  return { done, failed };
}

module.exports = { transcribePending, markLeadVisitedFromRecording, markVisitsFromExistingRecordings, VOICE_VISIT_NOTE };
