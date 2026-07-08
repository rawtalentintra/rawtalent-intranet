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

module.exports = { isConfigured, listRecordings, getRecording, testConnection };
