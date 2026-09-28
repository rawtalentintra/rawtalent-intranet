const { getDb } = require('../db/database');

// JobAdder integration — "Sync candidates/placements into HeartBeat"
// (application registered 2026-09-11). OAuth2 authorization-code flow per
// JobAdder's own docs (https://developers.jobadder.com/docs/ — Getting
// Started/Authentication) — verified directly against that page and
// https://jobadderapi.zendesk.com/hc/en-us/articles/360022196774 rather
// than assumed, since getting an OAuth integration wrong fails silently
// until someone actually tries to use it.
const AUTHORIZE_URL = 'https://id.jobadder.com/connect/authorize';
const TOKEN_URL = 'https://id.jobadder.com/connect/token';

// Narrow scopes — JobAdder's own docs explicitly warn against the broad
// `read`/`write` scopes ("limit the scopes that you request to the bare
// minimum so that users will feel confident... when granting access"),
// listing read_candidate/read_placement as the specific named scopes for
// exactly what this integration is for. offline_access is required to get
// a refresh token at all — without it the access token (60 min lifetime)
// would need a fresh human login every hour, useless for a background sync.
// read_job/read_jobad added 2026-09-28 (Joy: needs open job ad info) —
// confirmed against JobAdder's own OpenAPI spec: GET /jobs (job status,
// company, active=true filter) needs read_job; GET /jobads and
// GET /jobboards/{id}/ads (the actual posted ad content/dates) need
// read_jobad. Scope changes only take effect on a fresh authorization —
// the existing refresh token was issued under the old scope list and
// won't gain these; Settings → Connect JobAdder must be re-run once this
// is deployed.
const SCOPES = 'read_candidate read_placement read_job read_jobad offline_access';

// Must exactly match one of the "Authorized redirect URIs" the JobAdder
// application was registered with — JobAdder's docs: "Redirect URI used
// must be the same as redirect URI used in the authorization url." Fixed
// as a constant (not derived from the incoming request's host) since a
// mismatch here fails the token exchange outright, and this can only ever
// be tested against the one real, registered production URL anyway.
const REDIRECT_URI = process.env.JOBADDER_REDIRECT_URI || 'https://rawtalent-internal.app/auth/jobadder/callback';

// Refresh a bit before actual expiry so a request never races an
// about-to-expire token — same margin/shape as webexService.js's own.
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

function isConfigured() {
  return !!(process.env.JOBADDER_CLIENT_ID && process.env.JOBADDER_CLIENT_SECRET);
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.JOBADDER_CLIENT_ID,
    scope: SCOPES,
    // id.jobadder.com/connect/* is a standard IdentityServer instance, which
    // silently re-issues a token scoped to whatever was already granted
    // instead of re-prompting when a user re-authorizes an app they'd
    // already approved — confirmed the hard way 2026-09-28: adding
    // read_job/read_jobad to SCOPES and having Joy click through again
    // still came back scoped to the old read_candidate/read_placement
    // grant (GET /jobs returned insufficient_scope right after). Passing
    // the standard OIDC `prompt=consent` forces JobAdder to show the real
    // consent screen for the current SCOPES list every time, instead of
    // silently reusing a stale grant — needed on top of a fresh state param
    // whenever SCOPES changes, not just on first-ever connection.
    prompt: 'consent',
    redirect_uri: REDIRECT_URI,
    state
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function loadTokenState(db) {
  const res = await db.execute('SELECT * FROM jobadder_auth_state WHERE id = 1');
  return res.rows[0] || null;
}

// The one-time step a real human (an admin, via GET /auth/jobadder) has to
// complete in their own browser — JobAdder requires an actual login +
// consent screen, which can't be done any other way. connectedByEmail is
// purely informational (shown on an admin "connected as" status line),
// not itself the identity the API calls run as — that's whichever
// JobAdder user actually clicked "Allow" on JobAdder's own screen.
async function exchangeCodeForToken(code, connectedByEmail) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: process.env.JOBADDER_CLIENT_ID,
      client_secret: process.env.JOBADDER_CLIENT_SECRET
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`JobAdder token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const db = getDb();
  const expiresAt = Date.now() + data.expires_in * 1000;
  await db.execute({
    sql: `INSERT INTO jobadder_auth_state (id, access_token, refresh_token, access_token_expires_at, api_base_url, instance, account, connected_by, connected_at, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, now(), now())
          ON CONFLICT (id) DO UPDATE SET
            access_token = excluded.access_token, refresh_token = excluded.refresh_token,
            access_token_expires_at = excluded.access_token_expires_at, api_base_url = excluded.api_base_url,
            instance = excluded.instance, account = excluded.account, connected_by = excluded.connected_by,
            connected_at = excluded.connected_at, updated_at = now()`,
    args: [data.access_token, data.refresh_token, expiresAt, data.api || null, data.instance != null ? String(data.instance) : null, data.account != null ? String(data.account) : null, connectedByEmail]
  });
  return data;
}

async function refreshAccessToken(db, state) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.JOBADDER_CLIENT_ID,
      client_secret: process.env.JOBADDER_CLIENT_SECRET,
      refresh_token: state.refresh_token
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // invalid_grant here means the refresh token itself is dead (2 weeks
    // unused, or the JobAdder user who granted access was removed — see
    // JobAdder's own docs) — the caller needs a real human to reconnect via
    // GET /auth/jobadder again, not a retry.
    throw new Error(`JobAdder token refresh failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const expiresAt = Date.now() + data.expires_in * 1000;
  await db.execute({
    sql: `UPDATE jobadder_auth_state
          SET access_token = ?, refresh_token = ?, access_token_expires_at = ?, api_base_url = ?, updated_at = now()
          WHERE id = 1`,
    args: [data.access_token, data.refresh_token || state.refresh_token, expiresAt, data.api || state.api_base_url]
  });
  return { accessToken: data.access_token, apiBaseUrl: data.api || state.api_base_url };
}

// Returns null if never connected — callers should treat that as "not
// authorized yet" (prompt to connect), not throw an error for it.
async function getValidAccessToken() {
  if (!isConfigured()) return null;
  const db = getDb();
  const state = await loadTokenState(db);
  if (!state || !state.refresh_token) return null;
  const stillValid = state.access_token && Number(state.access_token_expires_at) - Date.now() > EXPIRY_SAFETY_MARGIN_MS;
  if (stillValid) return { accessToken: state.access_token, apiBaseUrl: state.api_base_url };
  return refreshAccessToken(db, state);
}

async function connectionStatus() {
  if (!isConfigured()) return { configured: false, connected: false };
  const db = getDb();
  const state = await loadTokenState(db);
  if (!state || !state.refresh_token) return { configured: true, connected: false };
  return {
    configured: true, connected: true,
    instance: state.instance, account: state.account,
    connectedBy: state.connected_by, connectedAt: state.connected_at
  };
}

module.exports = {
  isConfigured, buildAuthorizeUrl, exchangeCodeForToken, getValidAccessToken, connectionStatus,
  REDIRECT_URI, SCOPES
};
