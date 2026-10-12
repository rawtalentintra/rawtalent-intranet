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

module.exports = { transcribePending };
