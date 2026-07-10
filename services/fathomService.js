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

async function fathomCall(path, params = {}) {
  const token = getToken();
  if (!token) throw new Error('Fathom is not configured. Set FATHOM_API_KEY.');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${FATHOM_API}${path}${qs ? `?${qs}` : ''}`, {
    headers: { 'X-Api-Key': token }
  });
  if (!res.ok) throw new Error(`Fathom API error (${path}): ${res.status} ${res.statusText}`);
  return res.json();
}

async function listMeetingsSince(createdAfter) {
  let items = [];
  let cursor;
  do {
    const data = await fathomCall('/meetings', {
      include_transcript: 'true',
      created_after: createdAfter,
      ...(cursor ? { cursor } : {})
    });
    items = items.concat(data.items || []);
    cursor = data.next_cursor || null;
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

module.exports = { runFathomScan, isConfigured: () => !!getToken() };
