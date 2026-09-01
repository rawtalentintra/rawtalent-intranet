const { google } = require('googleapis');
const { getDb } = require('../db/database');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
// Added only to the oauth-connect flow's own consent request (not the
// delegation path, which never calls Google's userinfo endpoint) — needed
// so saveTokensForPartner can identify which real Google account just
// connected via oauth2.userinfo.get() below.
const CONSENT_SCOPES = [...SCOPES, 'https://www.googleapis.com/auth/userinfo.email'];

function getServiceAccountCredentials() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return null;
  try {
    return JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString());
  } catch {
    console.warn('Calendar: invalid service account key');
    return null;
  }
}

// 'delegation' (default): the same service account already used for Drive
// impersonates the partner's own rawtalent.com.au mailbox via domain-wide
// delegation — requires that delegation to be authorized once in the
// Workspace Admin console (Security → Access and data control → API
// controls → Domain-wide Delegation), using this service account's Client
// ID and the calendar scope above. No per-partner login needed, but does
// need Workspace super-admin access to set up.
// 'oauth': per-partner OAuth consent — each partner personally clicks
// "Connect my Calendar" once (see buildConsentUrl/exchangeCodeForTokens
// below and routes/calendarSync.js's /connect, /oauth-callback). Built
// 2026-09-01 specifically as a lighter-weight alternative to domain-wide
// delegation (Joy: "really going to be very complicated" to do the
// Workspace Admin dance) — reuses the OAuth client already registered for
// "Sign in with Google" (GOOGLE_CLIENT_ID/SECRET), no new Google Cloud app
// registration needed, and no Workspace admin involvement at all.
function authMode() {
  return process.env.CALENDAR_AUTH_MODE === 'oauth' ? 'oauth' : 'delegation';
}

// ─── OAuth (per-partner) path ────────────────────────────────────────
function getOAuthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return null;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.APP_URL || 'http://localhost:3000') + '/api/calendar-sync/oauth-callback'
  );
}

// `state` carries the partner label through Google's redirect round-trip
// (Google echoes it back verbatim on the callback) — this is how the
// callback knows WHICH partner just consented, since Google's own OAuth
// response only identifies the Google account, not our internal label.
function buildConsentUrl(partnerLabel) {
  const client = getOAuthClient();
  if (!client) throw new Error('Google OAuth is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET missing)');
  return client.generateAuthUrl({
    access_type: 'offline', // required to get a refresh_token back at all
    prompt: 'consent',      // forces Google to re-issue a refresh_token even for a partner who's consented before — offline access otherwise only arrives on the FIRST consent
    scope: CONSENT_SCOPES,
    state: partnerLabel
  });
}

// Exchanges the callback's one-time code for tokens, resolves which real
// Google account just connected, and stores/replaces this partner's
// connection row. Throws with a specific, actionable message when Google
// doesn't hand back a refresh_token — the single most common OAuth support
// issue (happens when the same Google account already granted this exact
// consent before and prompt=consent didn't take, or was bypassed) — this
// is a real user-facing error, not a generic failure.
async function saveTokensForPartner(partnerLabel, code, connectedByEmail) {
  const client = getOAuthClient();
  if (!client) throw new Error('Google OAuth is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET missing)');
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token for this connection. This usually means the account already granted access before — go to myaccount.google.com/permissions, remove RawTalent HeartBeat\'s access, then try connecting again.');
  }
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ auth: client, version: 'v2' });
  const { data: profile } = await oauth2.userinfo.get();
  const googleEmail = profile.email;

  await getDb().execute({
    sql: `INSERT INTO calendar_oauth_connections (partner_label, google_email, refresh_token, access_token, token_expiry, connected_by_email)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (partner_label) DO UPDATE SET
            google_email = excluded.google_email, refresh_token = excluded.refresh_token,
            access_token = excluded.access_token, token_expiry = excluded.token_expiry,
            connected_by_email = excluded.connected_by_email, updated_at = now()`,
    args: [partnerLabel, googleEmail, tokens.refresh_token, tokens.access_token || null,
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null, connectedByEmail]
  });
  return googleEmail;
}

async function disconnectPartner(partnerLabel) {
  await getDb().execute({ sql: 'DELETE FROM calendar_oauth_connections WHERE partner_label = ?', args: [partnerLabel] });
}

async function listOAuthConnections() {
  const rows = (await getDb().execute('SELECT partner_label, google_email, connected_at, connected_by_email FROM calendar_oauth_connections')).rows;
  return rows;
}

// `ownerEmail` in both modes is the partner's real Google account email —
// in delegation mode that's whatever CALENDAR_PARTNER_MAP says; in oauth
// mode it's whichever account the partner actually connected with
// (calendar_oauth_connections.google_email). Async in both modes now (the
// oauth path needs a DB lookup) — every caller already awaits this.
async function getCalendarClientFor(ownerEmail) {
  if (authMode() === 'oauth') {
    const row = (await getDb().execute({ sql: 'SELECT * FROM calendar_oauth_connections WHERE google_email = ?', args: [ownerEmail] })).rows[0];
    if (!row) return null;
    const client = getOAuthClient();
    if (!client) return null;
    client.setCredentials({
      refresh_token: row.refresh_token,
      access_token: row.access_token || undefined,
      expiry_date: row.token_expiry ? new Date(row.token_expiry).getTime() : undefined
    });
    // googleapis auto-refreshes the access token off the refresh_token
    // when needed and fires this event with the new one — persisted
    // best-effort so the next call within its lifetime doesn't need
    // another refresh round trip. Never blocks/throws over a write failure.
    client.on('tokens', (tokens) => {
      if (!tokens.access_token) return;
      getDb().execute({
        sql: 'UPDATE calendar_oauth_connections SET access_token = ?, token_expiry = ?, updated_at = now() WHERE partner_label = ?',
        args: [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null, row.partner_label]
      }).catch(() => {});
    });
    return google.calendar({ version: 'v3', auth: client });
  }

  const credentials = getServiceAccountCredentials();
  if (!credentials) return null;
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
    subject: ownerEmail
  });
  return google.calendar({ version: 'v3', auth });
}

function isConfigured() {
  if (authMode() === 'oauth') return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  return !!getServiceAccountCredentials();
}

module.exports = {
  getCalendarClientFor, isConfigured, authMode,
  buildConsentUrl, saveTokensForPartner, disconnectPartner, listOAuthConnections
};
