// Webex calls (recorded by Dubber, stored in call_recordings) matched to a
// lead or centre by phone number (Joy, 2026-11-23). A Workforce Partner's
// Webex call shows up under that lead/centre's Call Notes with its
// recording, transcript and an AI summary.
//
// Matching is on the last 9 digits of the number, so 0412 345 678,
// +61412345678 and 61 412 345 678 all match. Numbers shorter than 9 digits
// (Webex extensions like "205", or junk) never match anything.
const { getDb } = require('../db/database');
const { analyzeVisitFromTranscript } = require('./centreVisitAnalysisService');

const DIGITS_SQL = (col) => `right(regexp_replace(coalesce(${col},''), '[^0-9]', '', 'g'), 9)`;

// 13xx / 1300 / 1800 numbers are skipped: they're head-office lines shared
// by many centres (e.g. Guardian's 1300 number), so a call on one can't be
// tied to this particular centre.
function phoneKey(p) {
  let d = String(p || '').replace(/[^0-9]/g, '');
  if (d.startsWith('61')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (d.length < 9 || d.startsWith('1')) return null;
  return d.slice(-9);
}

async function findCallsForPhones(phones, limit = 50) {
  const keys = [...new Set((phones || []).map(phoneKey).filter(Boolean))];
  if (!keys.length) return [];
  const r = await getDb().execute({
    sql: `SELECT id, call_type, to_number, from_number, rep_name, duration_seconds, start_time_iso,
                 has_audio, (transcript IS NOT NULL AND transcript != '') AS has_transcript,
                 call_summary, call_summary_outcome
          FROM call_recordings
          WHERE ${DIGITS_SQL('to_number')} = ANY(?) OR ${DIGITS_SQL('from_number')} = ANY(?)
          ORDER BY start_time_iso DESC NULLS LAST LIMIT ?`,
    args: [keys, keys, limit]
  });
  return r.rows.map(c => ({ ...c, matchedNumber: c.call_type === 'inbound' ? c.from_number : c.to_number }));
}

// Summary is generated once from the real transcript and cached. If there is
// no transcript yet, it tries to fetch it from Dubber first. It never writes
// a summary without a transcript, so nothing is made up.
async function getOrCreateSummary(recordingId, contextName) {
  const db = getDb();
  let row = (await db.execute({ sql: 'SELECT id, transcript, call_summary, call_summary_outcome, has_audio FROM call_recordings WHERE id = ?', args: [recordingId] })).rows[0];
  if (!row) return { error: 'Call not found', status: 404 };
  if (row.call_summary) return { summary: row.call_summary, outcome: row.call_summary_outcome, transcript: row.transcript };
  if (!row.transcript) {
    try {
      await require('./dubberService').fetchContentForRecording(recordingId, { skipAudio: !!row.has_audio });
      row = (await db.execute({ sql: 'SELECT id, transcript, has_audio FROM call_recordings WHERE id = ?', args: [recordingId] })).rows[0];
    } catch {}
  }
  if (!row.transcript) return { summary: null, outcome: null, transcript: null, pending: true };
  const { outcome, notesSummary } = await analyzeVisitFromTranscript(row.transcript, contextName);
  if (notesSummary) {
    await db.execute({ sql: 'UPDATE call_recordings SET call_summary = ?, call_summary_outcome = ?, call_summary_at = now() WHERE id = ?', args: [notesSummary, outcome, recordingId] });
  }
  return { summary: notesSummary || null, outcome: outcome || null, transcript: row.transcript };
}

module.exports = { phoneKey, findCallsForPhones, getOrCreateSummary };
