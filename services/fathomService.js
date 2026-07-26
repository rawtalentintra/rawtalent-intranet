const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { logActivity } = require('./activityLog');
const { classifyConversation } = require('./faqClassifier');

const FATHOM_API = 'https://api.fathom.ai/external/v1';
const MAX_MEETINGS_PER_SCAN = 100;
const DEFAULT_LOOKBACK_DAYS = 30; // for the very first scan

function getToken() {
  return process.env.FATHOM_API_KEY || null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fathom's API rate-limits fairly aggressively on the paginated /meetings
// endpoint when include_transcript is set — back off and retry rather than
// failing a whole sync over a transient 429.
async function fathomCall(path, params = {}) {
  const token = getToken();
  if (!token) throw new Error('Fathom is not configured. Set FATHOM_API_KEY.');
  const qs = new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${FATHOM_API}${path}${qs ? `?${qs}` : ''}`, {
      headers: { 'X-Api-Key': token }
    });
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Fathom API error (${path}): ${res.status} ${res.statusText}`);
    return res.json();
  }
  throw new Error(`Fathom API error (${path}): too many rate-limit retries`);
}

async function listMeetingsSince(createdAfter) {
  let items = [];
  let cursor;
  let first = true;
  do {
    const data = await fathomCall('/meetings', {
      include_transcript: 'true',
      created_after: createdAfter,
      ...(cursor ? { cursor } : {})
    });
    items = items.concat(data.items || []);
    cursor = data.next_cursor || null;
    if (!first) await sleep(1200); // pagination also rate-limits back-to-back
    first = false;
  } while (cursor);
  return items;
}

function transcriptToText(transcript) {
  if (!Array.isArray(transcript)) return '';
  return transcript.map(line => line.text).filter(Boolean).join('\n');
}

async function runFathomScan(triggeredBy) {
  if (!getToken()) throw new Error('Fathom is not configured. Set the FATHOM_API_KEY environment variable.');

  const db = getDb();
  const stateRes = await db.execute("SELECT last_synced_at FROM fathom_scan_state WHERE id = 1");
  const createdAfter = stateRes.rows[0]?.last_synced_at || new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const meetings = await listMeetingsSince(createdAfter);
  let meetingsProcessed = 0;
  let candidatesFound = 0;
  let truncated = false;
  const errors = [];
  let newestCreatedAt = createdAfter;

  for (const meeting of meetings) {
    if (meetingsProcessed >= MAX_MEETINGS_PER_SCAN) { truncated = true; break; }
    try {
      if (meeting.created_at && new Date(meeting.created_at) > new Date(newestCreatedAt)) {
        newestCreatedAt = meeting.created_at;
      }

      const sourceRef = String(meeting.url || meeting.share_url || meeting.meeting_url || meeting.created_at);
      const existing = await db.execute({ sql: 'SELECT id FROM faq_candidates WHERE source_ref = ?', args: [sourceRef] });
      if (existing.rows[0]) continue;

      meetingsProcessed++;
      const text = transcriptToText(meeting.transcript);
      if (!text.trim()) continue;

      const classification = await classifyConversation(text);
      const isCandidate = classification.isFaqCandidate && classification.question && classification.answer;
      const meetingTitle = meeting.title || meeting.meeting_title || 'Fathom meeting';
      await db.execute({
        sql: `INSERT INTO faq_candidates
              (id, source, source_channel, source_ref, source_date, raw_excerpt, suggested_question, suggested_answer, classification_reason, status)
              VALUES (?, 'fathom', ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          uuidv4(), meetingTitle, sourceRef, meeting.recording_start_time || meeting.created_at || null, text.slice(0, 4000),
          classification.question || null, classification.answer || null, classification.reason || null,
          isCandidate ? 'pending' : 'auto_rejected'
        ]
      });
      if (isCandidate) candidatesFound++;
    } catch (err) {
      errors.push({ meeting: meeting.title || meeting.meeting_title || meeting.url, reason: err.message });
    }
  }

  await db.execute({
    sql: `INSERT INTO fathom_scan_state (id, last_synced_at, updated_at) VALUES (1, ?, now())
          ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at, updated_at = now()`,
    args: [newestCreatedAt]
  });

  await logActivity('faq_scan', 'Fathom scan', 'completed', `${meetings.length} meetings checked, ${candidatesFound} new candidate${candidatesFound !== 1 ? 's' : ''} found${truncated ? ' (truncated — run again to continue)' : ''}`, triggeredBy);
  return { meetingsScanned: meetings.length, meetingsProcessed, candidatesFound, truncated, errors };
}

// Persists FULL transcripts (with per-line speaker attribution) into
// fathom_meetings, so any future analysis (e.g. "what did Liam say about
// project X") can query Postgres instead of re-hitting the Fathom API.
// Separate sync-state row from the FAQ scan above, since the two jobs
// have different lookback needs and shouldn't interfere with each other.
async function syncTranscripts(triggeredBy) {
  if (!getToken()) throw new Error('Fathom is not configured. Set the FATHOM_API_KEY environment variable.');

  const db = getDb();
  const stateRes = await db.execute('SELECT last_synced_at FROM fathom_transcript_sync_state WHERE id = 1');
  const createdAfter = stateRes.rows[0]?.last_synced_at || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  const meetings = await listMeetingsSince(createdAfter);
  let newestCreatedAt = createdAfter;
  let stored = 0;
  const errors = [];

  for (const meeting of meetings) {
    try {
      if (meeting.created_at && new Date(meeting.created_at) > new Date(newestCreatedAt)) {
        newestCreatedAt = meeting.created_at;
      }
      if (!meeting.recording_id) continue;

      const speakers = [...new Set((meeting.transcript || []).map(l => l.speaker?.display_name).filter(Boolean))];
      await db.execute({
        sql: `INSERT INTO fathom_meetings
              (recording_id, title, meeting_url, share_url, fathom_created_at, recording_start_time, recording_end_time,
               transcript, speakers, calendar_invitees, default_summary, action_items, highlights, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
              ON CONFLICT (recording_id) DO UPDATE SET
                title = excluded.title, meeting_url = excluded.meeting_url, share_url = excluded.share_url,
                transcript = excluded.transcript, speakers = excluded.speakers,
                calendar_invitees = excluded.calendar_invitees, default_summary = excluded.default_summary,
                action_items = excluded.action_items, highlights = excluded.highlights, synced_at = now()`,
        args: [
          meeting.recording_id, meeting.title || meeting.meeting_title || null,
          meeting.meeting_url || null, meeting.share_url || meeting.url || null,
          meeting.created_at || null, meeting.recording_start_time || null, meeting.recording_end_time || null,
          JSON.stringify(meeting.transcript || []), speakers,
          JSON.stringify(meeting.calendar_invitees || []), meeting.default_summary || null,
          JSON.stringify(meeting.action_items || null), JSON.stringify(meeting.highlights || null)
        ]
      });
      stored++;
    } catch (err) {
      errors.push({ meeting: meeting.title || meeting.meeting_title || meeting.url, reason: err.message });
    }
  }

  await db.execute({
    sql: `INSERT INTO fathom_transcript_sync_state (id, last_synced_at, updated_at) VALUES (1, ?, now())
          ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at, updated_at = now()`,
    args: [newestCreatedAt]
  });

  await logActivity('fathom_transcript_sync', 'Fathom transcript sync', 'completed', `${meetings.length} meetings checked, ${stored} stored/updated`, triggeredBy);
  return { meetingsScanned: meetings.length, stored, errors };
}

module.exports = { runFathomScan, syncTranscripts, isConfigured: () => !!getToken() };
