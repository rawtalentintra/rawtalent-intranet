const { getDb } = require('../db/database');
const groqTranscription = require('./groqTranscriptionService');
const { BUCKETS, uploadBase64, extForMimetype } = require('./storageService');

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

// Confirmed via Dubber's official "Get AI Information" doc: transcript text
// lives in this account's Unified Capture Plus One license, at
// GET /accounts/{account_id}/recordings/{recording_id}/ai, one entry per
// sentence under sentences[].content (optionally with a speaker label).
async function getTranscript(recordingId) {
  const info = await dubberCall(`/accounts/${getAccountId()}/recordings/${recordingId}/ai`);
  const sentences = info.sentences || [];
  if (!sentences.length) throw new Error('Dubber AI info response had no sentences — transcript may not be ready yet for this call.');
  // Dubber's per-sentence content can carry inline markup (e.g. sentiment
  // highlighting) — strip it here so nothing downstream (grading, display,
  // search) ever has to deal with stray tags leaking into plain text.
  const stripMarkup = text => (text || '').replace(/<[^>]+>/g, '').trim();
  return sentences
    .map(s => s.speaker ? `${stripMarkup(s.speaker)}: ${stripMarkup(s.content)}` : stripMarkup(s.content))
    .join('\n');
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

// Fetches audio + transcript for one recording and persists whatever succeeds.
// Shared by the batch sync pass and the single-call "Fetch Content" action on
// a Pending row — skipAudio/existingTranscript let the caller avoid redoing
// work that's already done for that recording.
async function fetchContentForRecording(recordingId, { skipAudio = false, existingTranscript = null } = {}) {
  const db = getDb();
  let audio = null, audioFetched = false, audioError = null;

  if (!skipAudio) {
    try {
      audio = await downloadRecordingAudio(recordingId);
      await db.execute({ sql: 'UPDATE call_recordings SET has_audio = true WHERE id = ?', args: [recordingId] });
      const mimetype = audio.mimetype || 'audio/mpeg';
      const path = `${recordingId}.${extForMimetype(mimetype)}`;
      await uploadBase64(BUCKETS.callRecordings, path, audio.data, mimetype);
      await db.execute({
        sql: `INSERT INTO call_recording_audio (recording_id, storage_path, mimetype, filesize) VALUES (?, ?, ?, ?)
              ON CONFLICT(recording_id) DO UPDATE SET storage_path = excluded.storage_path, mimetype = excluded.mimetype, filesize = excluded.filesize, fetched_at = now()`,
        args: [recordingId, path, mimetype, audio.data?.length || null]
      });
      audioFetched = true;
    } catch (err) {
      audioError = err.message;
    }
  }

  let transcript = existingTranscript || null;
  let transcriptFetched = false;
  if (!transcript) {
    let transcriptError = null;
    try {
      transcript = await getTranscript(recordingId);
    } catch (err) {
      if (audio) {
        try { transcript = await groqTranscription.transcribeAudio(audio.data, audio.mimetype); }
        catch (groqErr) { transcriptError = groqErr.message; }
      } else {
        transcriptError = err.message;
      }
    }
    if (transcript) {
      await db.execute({ sql: 'UPDATE call_recordings SET transcript = ? WHERE id = ?', args: [transcript, recordingId] });
      transcriptFetched = true;
    }
    return { audioFetched, audioError, transcriptFetched, transcriptError };
  }

  return { audioFetched, audioError, transcriptFetched, transcriptError: null };
}

const SYNC_PAGE_SIZE = 100;
const SYNC_MAX_PAGES = 5; // 'recent' mode: caps a click at ~500 recordings checked, cheap (1 API call/page)
const BACKFILL_MAX_PAGES = 15; // 'older' mode: pages much further back per click — safe since before_id is a real cursor, not the unconfirmed "offset" param
const MAX_CONTENT_FETCH_PER_RUN = 25; // transcript+audio pass: bounds a click's runtime and rate-limit exposure

async function insertRecordingIfNew(db, r) {
  const existing = await db.execute({ sql: 'SELECT id FROM call_recordings WHERE id = ?', args: [r.id] });
  if (existing.rows[0]) return false;

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
  return true;
}

// Two-phase sync, in either of two directions:
//  - 'recent' (default): pages forward from the top of Dubber's list to catch
//    newly-happened calls. Uses "offset", which Dubber never confirmed as a
//    real parameter — if it's ignored server-side, every page just re-returns
//    the same top window, which is harmless here since new calls naturally
//    stop appearing once caught up.
//  - 'older': backfills history from the oldest call currently stored,
//    using Dubber's confirmed before_id cursor. This is what actually reaches
//    calls older than whatever the very first sync's 500-record window
//    covered — offset-based paging could never get there since it always
//    restarts from the top on every click.
//  1. Metadata pass stores anything new, marked content_synced=0.
//  2. Content pass — for up to MAX_CONTENT_FETCH_PER_RUN rows still missing
//     transcript/audio (from this run or any earlier one), fetches both and
//     marks content_synced=1 only once that succeeds.
async function syncRecordings(direction = 'recent') {
  const db = getDb();
  let totalSeen = 0, totalNew = 0, reachedEnd = false;

  if (direction === 'older') {
    const oldestRow = await db.execute('SELECT id FROM call_recordings ORDER BY start_time_iso ASC LIMIT 1');
    let beforeId = oldestRow.rows[0]?.id || null;

    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      const params = { count: SYNC_PAGE_SIZE };
      if (beforeId) params.before_id = beforeId;
      const data = await listRecordings(params);
      const recordings = data.recordings || data.items || [];
      if (!recordings.length) { reachedEnd = true; break; }
      totalSeen += recordings.length;

      for (const r of recordings) {
        if (await insertRecordingIfNew(db, r)) totalNew++;
      }

      // Move the cursor to the oldest ID actually returned this page — a
      // short page means Dubber has nothing older left to give us.
      beforeId = recordings[recordings.length - 1].id;
      if (recordings.length < SYNC_PAGE_SIZE) { reachedEnd = true; break; }
    }
  } else {
    let offset = 0;
    for (let page = 0; page < SYNC_MAX_PAGES; page++) {
      const data = await listRecordings({ count: SYNC_PAGE_SIZE, offset });
      const recordings = data.recordings || data.items || [];
      if (!recordings.length) break;
      totalSeen += recordings.length;

      let newInPage = 0;
      for (const r of recordings) {
        if (await insertRecordingIfNew(db, r)) { newInPage++; totalNew++; }
      }
      if (newInPage === 0) break; // caught up, or offset isn't real — either way, stop
      offset += SYNC_PAGE_SIZE;
    }
  }

  // Content pass — download audio, then get a transcript. Dubber's own AI
  // endpoint is tried first (it's already scrubbed/paid for on this account's
  // license and needs no extra API call spacing beyond the standard rate
  // limit); Groq only runs as a fallback if Dubber's transcript isn't ready
  // or errors for a given call. Audio and transcript are independent
  // try/catches, so either one succeeding never depends on the other.
  // Gated on has_audio, so already-completed rows don't get re-fetched forever.
  const pending = await db.execute({
    sql: 'SELECT id, transcript FROM call_recordings WHERE has_audio = false ORDER BY start_time_iso DESC LIMIT ?',
    args: [MAX_CONTENT_FETCH_PER_RUN]
  });

  let audioFetched = 0, transcriptFetched = 0;
  const contentErrors = [];
  for (const row of pending.rows) {
    if (audioFetched + transcriptFetched > 0) await sleepMs(600); // paces Dubber-side requests
    const result = await fetchContentForRecording(row.id, { existingTranscript: row.transcript });
    if (result.audioFetched) audioFetched++;
    if (result.audioError) contentErrors.push({ recordingId: row.id, type: 'audio', reason: result.audioError });
    if (result.transcriptFetched) transcriptFetched++;
    if (result.transcriptError) contentErrors.push({ recordingId: row.id, type: 'transcript', reason: result.transcriptError });
  }
  const contentFetched = audioFetched; // audio is the currently-achievable metric

  await db.execute({
    sql: `INSERT INTO dubber_sync_state (id, last_synced_at, total_synced, updated_at) VALUES (1, now(), ?, now())
          ON CONFLICT(id) DO UPDATE SET last_synced_at = now(), total_synced = dubber_sync_state.total_synced + excluded.total_synced, updated_at = now()`,
    args: [totalNew]
  });

  return { totalSeen, totalNew, contentFetched, transcriptFetched, contentPending: pending.rows.length - contentFetched, contentErrors: contentErrors.slice(0, 3), reachedEnd };
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

module.exports = { isConfigured, listRecordings, getRecording, getTranscript, downloadRecordingAudio, testConnection, syncRecordings, fetchContentForRecording };
