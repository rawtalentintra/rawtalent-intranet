const { getDb } = require('../db/database');

const REGION = process.env.DUBBER_REGION || 'au';
const BASE_URL = `https://api.dubber.net/${REGION}/v1`;

let cachedToken = null; // { accessToken, expiresAt }

function getCredentials() {
  const clientId = process.env.DUBBER_CLIENT_ID;
  const clientSecret = process.env.DUBBER_CLIENT_SECRET;
  const authId = process.env.DUBBER_AUTH_ID;
  const authToken = process.env.DUBBER_AUTH_TOKEN;
  if (!clientId || !clientSecret || !authId || !authToken) return null;
  return { clientId, clientSecret, authId, authToken };
}

function isConfigured() {
  return !!getCredentials();
}

// Dubber bearer tokens are valid ~24h and token requests are rate-limited
// (500/day), so we cache in memory and only refresh when it's actually expired.
async function getAccessToken() {
  const creds = getCredentials();
  if (!creds) throw new Error('Dubber is not configured. Set DUBBER_CLIENT_ID, DUBBER_CLIENT_SECRET, DUBBER_AUTH_ID, and DUBBER_AUTH_TOKEN.');

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    username: creds.authId,
    password: creds.authToken,
    grant_type: 'password'
  });

  const res = await fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dubber token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Dubber token response did not include an access_token');

  // expires_in is in seconds; default to 23h if not provided, to stay safely under the ~24h window
  const expiresInMs = (data.expires_in ? data.expires_in * 1000 : 23 * 60 * 60 * 1000);
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + expiresInMs };
  return cachedToken.accessToken;
}

async function dubberCall(path, params = {}) {
  const token = await getAccessToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE_URL}${path}${qs ? `?${qs}` : ''}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dubber API error (${path}): ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

// account_id isn't confirmed from public docs — falls back to the Auth ID, which
// Dubber's own docs describe as identifying "your company's Dubber account".
// Override with DUBBER_ACCOUNT_ID if that guess turns out to be wrong.
function getAccountId() {
  return process.env.DUBBER_ACCOUNT_ID || process.env.DUBBER_AUTH_ID;
}

async function listRecordings(params = {}) {
  return dubberCall(`/accounts/${getAccountId()}/recordings`, params);
}

async function getRecording(recordingId) {
  return dubberCall(`/recordings/${recordingId}`);
}

// PENDING: fill this in once findTranscript() confirms which endpoint actually
// returns transcript data, and what shape it's in (plain text vs timestamped/
// speaker-labeled segments). Throws clearly rather than guessing at a shape.
async function getTranscript(recordingId) {
  throw new Error('Transcript source not yet confirmed — run Find Transcript in Call Quality Evaluator first.');
}

const SYNC_PAGE_SIZE = 100;
const SYNC_MAX_PAGES = 5; // caps a single sync click at ~500 recordings, well under Dubber's daily rate limit

// Pulls recent recordings and stores metadata locally so browsing/filtering never
// has to hit Dubber's rate-limited API. Only "count" is confirmed from public
// docs — "offset" is a best-effort guess at pagination. If the API ignores it and
// keeps returning the same page, every recording on it will already be stored and
// the loop stops itself (0 new = done), so an unsupported param degrades safely
// instead of looping or duplicating data. Click Sync again later to keep going.
async function syncRecordings() {
  const db = getDb();
  let totalSeen = 0, totalNew = 0, offset = 0;

  for (let page = 0; page < SYNC_MAX_PAGES; page++) {
    const data = await listRecordings({ count: SYNC_PAGE_SIZE, offset });
    const recordings = data.recordings || data.items || [];
    if (!recordings.length) break;
    totalSeen += recordings.length;

    let newInPage = 0;
    for (const r of recordings) {
      const existing = await db.execute({ sql: 'SELECT id FROM call_recordings WHERE id = ?', args: [r.id] });
      if (existing.rows[0]) continue;
      newInPage++; totalNew++;

      let startIso = null;
      try { startIso = r.start_time ? new Date(r.start_time).toISOString() : null; } catch {}

      await db.execute({
        sql: `INSERT INTO call_recordings
              (id, to_number, from_number, to_label, from_label, rep_name, call_type, duration_seconds, start_time, start_time_iso, status, sentiment_score, meta_tags)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          r.id, r.to || null, r.from || null, r.to_label || null, r.from_label || null,
          r.from_label || r.to_label || r.channel || null, r.call_type || null, r.duration ?? null,
          r.start_time || null, startIso, r.status || null, r.document_sentiment?.score ?? null,
          JSON.stringify(r.meta_tags || {})
        ]
      });
    }
    if (newInPage === 0) break; // caught up, or offset isn't real — either way, stop
    offset += SYNC_PAGE_SIZE;
  }

  await db.execute({
    sql: `INSERT INTO dubber_sync_state (id, last_synced_at, total_synced, updated_at) VALUES (1, datetime('now'), ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET last_synced_at = datetime('now'), total_synced = total_synced + excluded.total_synced, updated_at = datetime('now')`,
    args: [totalNew]
  });

  return { totalSeen, totalNew };
}

// Diagnostic only — the recording detail endpoint hasn't shown a playback URL
// field in samples so far; this surfaces the raw response so we can find it
// (e.g. by passing ?listener=, per third-party docs) before building real
// playback into the UI.
async function getRecordingPlaybackInfo(recordingId, listener) {
  return dubberCall(`/recordings/${recordingId}`, listener ? { listener } : {});
}

// Diagnostic only — pulls a very small sample so a super_admin can inspect the
// real response shape (especially where transcript data lives) before we build
// any grading logic against it.
async function testConnection() {
  const list = await listRecordings({ count: 3 });
  const recordings = list.recordings || list.items || [];
  let sampleDetail = null;
  const firstId = recordings[0]?.id || recordings[0]?.recording_id;
  if (firstId) {
    try { sampleDetail = await getRecording(firstId); } catch (err) { sampleDetail = { error: err.message }; }
  }
  return { accountId: getAccountId(), listResponse: list, sampleRecordingDetail: sampleDetail };
}

// Diagnostic only — the recordings endpoint returns a document_sentiment score,
// proving Dubber transcribes calls behind the scenes, but no public docs confirm
// where the actual transcript text lives. Rather than guess, try every plausible
// path for one real recording and report which ones actually return data.
async function findTranscript(recordingId) {
  const token = await getAccessToken();
  const candidates = [
    { label: 'GET /recordings/{id}/transcript', path: `/recordings/${recordingId}/transcript` },
    { label: 'GET /recordings/{id}/transcription', path: `/recordings/${recordingId}/transcription` },
    { label: 'GET /recordings/{id}/document', path: `/recordings/${recordingId}/document` },
    { label: 'GET /recordings/{id}/insights', path: `/recordings/${recordingId}/insights` },
    { label: 'GET /recordings/{id}?include_transcript=true', path: `/recordings/${recordingId}`, params: { include_transcript: 'true' } },
    { label: 'GET /documents/{id}', path: `/documents/${recordingId}` }
  ];

  const results = [];
  for (const c of candidates) {
    const qs = c.params ? `?${new URLSearchParams(c.params).toString()}` : '';
    try {
      const res = await fetch(`${BASE_URL}${c.path}${qs}`, { headers: { 'Authorization': `Bearer ${token}` } });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
      results.push({ label: c.label, status: res.status, ok: res.ok, body });
    } catch (err) {
      results.push({ label: c.label, status: null, ok: false, body: err.message });
    }
  }
  return { recordingId, attempts: results };
}

module.exports = { isConfigured, listRecordings, getRecording, getTranscript, testConnection, findTranscript, syncRecordings, getRecordingPlaybackInfo };
