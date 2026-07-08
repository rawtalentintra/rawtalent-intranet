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

// BLOCKED: Dubber's official "Get Recordings Details" doc confirms no transcript
// field exists on the recording resource, and error code 3014 ("Invalid
// Transcription") appears alongside *recording-creation* errors — meaning
// Dubber's transcription concept is for external systems submitting a
// transcript INTO Dubber, not Dubber generating and returning one. Transcript
// access likely requires a separate product/plan (e.g. a conversational-
// intelligence add-on) that isn't confirmed enabled on this account. Ask
// Dubber support directly rather than guessing further.
async function getTranscript(recordingId) {
  throw new Error('Transcript is not available via the standard recordings API on this account/plan — confirmed against Dubber\'s official docs. Ask Dubber support whether AI transcription is enabled and what endpoint exposes it.');
}

const LISTENER_EMAIL = process.env.DUBBER_LISTENER_EMAIL || 'joy@rawtalent.com.au';

// Confirmed via Dubber's official "Get Recording Link" doc:
// GET /recordings/{id}?listener=<email> returns a recording_url (presigned S3
// link) alongside the usual recording fields. We fetch that link directly
// (no Dubber auth needed — the URL itself is pre-signed) and store the bytes.
async function downloadRecordingAudio(recordingId) {
  const detail = await dubberCall(`/recordings/${recordingId}`, { listener: LISTENER_EMAIL });
  if (!detail.recording_url) throw new Error('Recording detail response did not include a recording_url — listener email may not be authorized for this call.');

  const audioRes = await fetch(detail.recording_url);
  if (!audioRes.ok) throw new Error(`Failed to download recording audio (${audioRes.status})`);
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  const mimetype = audioRes.headers.get('content-type') || 'audio/mpeg';
  return { data: buffer.toString('base64'), mimetype };
}

function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

const SYNC_PAGE_SIZE = 100;
const SYNC_MAX_PAGES = 5; // metadata-only pass: caps a click at ~500 recordings checked, cheap (1 API call/page)
const MAX_CONTENT_FETCH_PER_RUN = 25; // transcript+audio pass: bounds a click's runtime and rate-limit exposure

// Two-phase sync:
//  1. Metadata pass — pages through recent recordings (only "count" is a
//     confirmed param; "offset" is best-effort and degrades safely if
//     unsupported, since already-stored IDs are simply skipped) and stores
//     anything new, marked content_synced=0.
//  2. Content pass — for up to MAX_CONTENT_FETCH_PER_RUN rows still missing
//     transcript/audio (from this run or any earlier one), fetches both and
//     marks content_synced=1 only once that succeeds. Until the real
//     transcript/audio endpoints are confirmed, this pass will keep retrying
//     the same rows on every sync click and finding nothing — that's expected;
//     the moment they're confirmed, the very next click starts filling them in
//     with no further changes needed here.
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

  // Content pass — fetch transcript + audio for whatever's still missing them
  const pending = await db.execute({
    sql: 'SELECT id FROM call_recordings WHERE content_synced = 0 ORDER BY start_time_iso DESC LIMIT ?',
    args: [MAX_CONTENT_FETCH_PER_RUN]
  });

  let contentFetched = 0;
  const contentErrors = [];
  for (const row of pending.rows) {
    if (contentFetched > 0) await sleepMs(600); // stay under 2 calls/second across the two fetches below
    try {
      const transcript = await getTranscript(row.id);
      await sleepMs(600);
      const audio = await downloadRecordingAudio(row.id);
      await db.execute({ sql: 'UPDATE call_recordings SET transcript = ?, has_audio = 1, content_synced = 1 WHERE id = ?', args: [transcript, row.id] });
      await db.execute({
        sql: `INSERT INTO call_recording_audio (recording_id, data, mimetype, filesize) VALUES (?, ?, ?, ?)
              ON CONFLICT(recording_id) DO UPDATE SET data = excluded.data, mimetype = excluded.mimetype, filesize = excluded.filesize, fetched_at = datetime('now')`,
        args: [row.id, audio.data, audio.mimetype || 'audio/mpeg', audio.data?.length || null]
      });
      contentFetched++;
    } catch (err) {
      contentErrors.push({ recordingId: row.id, reason: err.message });
    }
  }

  await db.execute({
    sql: `INSERT INTO dubber_sync_state (id, last_synced_at, total_synced, updated_at) VALUES (1, datetime('now'), ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET last_synced_at = datetime('now'), total_synced = total_synced + excluded.total_synced, updated_at = datetime('now')`,
    args: [totalNew]
  });

  return { totalSeen, totalNew, contentFetched, contentPending: pending.rows.length - contentFetched, contentErrors: contentErrors.slice(0, 3) };
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Dubber's rate limit is 2 calls/second — firing several diagnostic requests
// back-to-back would trip "Forbidden: Account Over Queries Per Second Limit"
// (code 1021), which looks like a real rejection but actually means we never
// got a conclusive answer. This spaces requests out and retries once on a
// rate-limit response before giving up on that candidate.
async function rateLimitedFetch(url, token) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
  if (res.status === 403 && body?.code === 1021) {
    await sleep(1200);
    const retryRes = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const retryText = await retryRes.text();
    let retryBody;
    try { retryBody = JSON.parse(retryText); } catch { retryBody = retryText.slice(0, 500); }
    return { status: retryRes.status, ok: retryRes.ok, body: retryBody, rateLimitedFirstTry: true };
  }
  return { status: res.status, ok: res.ok, body };
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
    if (results.length > 0) await sleep(600); // stay under 2 calls/second
    const qs = c.params ? `?${new URLSearchParams(c.params).toString()}` : '';
    try {
      const result = await rateLimitedFetch(`${BASE_URL}${c.path}${qs}`, token);
      results.push({ label: c.label, ...result });
    } catch (err) {
      results.push({ label: c.label, status: null, ok: false, body: err.message });
    }
  }
  return { recordingId, attempts: results };
}

// Diagnostic only — same rate-limit-aware approach as findTranscript, but for
// finding which field/endpoint holds a playable audio URL.
async function findPlayback(recordingId) {
  const token = await getAccessToken();
  const candidates = [
    { label: 'GET /recordings/{id}', path: `/recordings/${recordingId}` },
    { label: `GET /recordings/{id}?listener=${LISTENER_EMAIL}`, path: `/recordings/${recordingId}`, params: { listener: LISTENER_EMAIL } }
  ];

  const results = [];
  for (const c of candidates) {
    if (results.length > 0) await sleep(600);
    const qs = c.params ? `?${new URLSearchParams(c.params).toString()}` : '';
    try {
      const result = await rateLimitedFetch(`${BASE_URL}${c.path}${qs}`, token);
      results.push({ label: c.label, ...result });
    } catch (err) {
      results.push({ label: c.label, status: null, ok: false, body: err.message });
    }
  }
  return { recordingId, attempts: results };
}

module.exports = { isConfigured, listRecordings, getRecording, getTranscript, downloadRecordingAudio, testConnection, findTranscript, findPlayback, syncRecordings, getRecordingPlaybackInfo };
