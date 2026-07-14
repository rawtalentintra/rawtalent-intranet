const { getDb } = require('../db/database');

const TOKEN_URL = 'https://webexapis.com/v1/access_token';
const PEOPLE_URL = 'https://webexapis.com/v1/people';

// Refresh a bit before actual expiry so a request never races an
// about-to-expire token.
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

function isConfigured() {
  return !!(process.env.WEBEX_CLIENT_ID && process.env.WEBEX_CLIENT_SECRET);
}

async function loadTokenState(db) {
  const res = await db.execute('SELECT * FROM webex_auth_state WHERE id = 1');
  return res.rows[0] || null;
}

// WEBEX_REFRESH_TOKEN in .env is only ever used to seed this table the very
// first time — after that, the DB copy (which rotates on every refresh) is
// the source of truth, since re-using a stale rotated-out refresh token
// would fail.
async function seedTokenStateIfEmpty(db) {
  const existing = await loadTokenState(db);
  if (existing) return existing;
  if (!process.env.WEBEX_REFRESH_TOKEN) return null;
  await db.execute({
    sql: `INSERT INTO webex_auth_state (id, access_token, refresh_token, access_token_expires_at)
          VALUES (1, NULL, ?, 0)
          ON CONFLICT (id) DO NOTHING`,
    args: [process.env.WEBEX_REFRESH_TOKEN]
  });
  return loadTokenState(db);
}

async function refreshAccessToken(db, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.WEBEX_CLIENT_ID,
      client_secret: process.env.WEBEX_CLIENT_SECRET,
      refresh_token: refreshToken
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webex token refresh failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const expiresAt = Date.now() + data.expires_in * 1000;
  await db.execute({
    sql: `UPDATE webex_auth_state
          SET access_token = ?, refresh_token = ?, access_token_expires_at = ?, updated_at = now()
          WHERE id = 1`,
    args: [data.access_token, data.refresh_token || refreshToken, expiresAt]
  });
  return { accessToken: data.access_token, expiresAt };
}

async function getAccessToken() {
  if (!isConfigured()) return null;
  const db = getDb();
  let state = await seedTokenStateIfEmpty(db);
  if (!state) return null; // not configured yet — no seed refresh token available

  const stillValid = state.access_token && Number(state.access_token_expires_at) - Date.now() > EXPIRY_SAFETY_MARGIN_MS;
  if (stillValid) return state.access_token;

  const { accessToken } = await refreshAccessToken(db, state.refresh_token);
  return accessToken;
}

// Webex's Person status is the same "on a call / in a meeting / do not
// disturb / active" signal shown as the colored dot next to someone's name
// in the Webex App — it can't say WHICH call or WHICH queue, just whether
// they're currently occupied.
async function fetchAgentStatuses() {
  const accessToken = await getAccessToken();
  if (!accessToken) return { configured: false, agents: [] };

  const res = await fetch(`${PEOPLE_URL}?max=1000`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webex people list failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const people = (data.items || []).map(p => ({
    webexId: p.id,
    email: (p.emails && p.emails[0]) || null,
    displayName: p.displayName || null,
    status: p.status || 'unknown'
  }));

  // Cross-reference against our own users table (email match) so the UI can
  // show the name/role RawTalent already knows this person by, rather than
  // whatever their Webex profile happens to say.
  const db = getDb();
  const usersRes = await db.execute("SELECT email, name, role FROM users WHERE active = true");
  const byEmail = new Map(usersRes.rows.map(u => [String(u.email).toLowerCase(), u]));

  const agents = people
    .filter(p => p.email && byEmail.has(p.email.toLowerCase()))
    .map(p => {
      const user = byEmail.get(p.email.toLowerCase());
      const since = recordStatusSince(p.email.toLowerCase(), p.status);
      return { email: p.email, name: user.name || p.displayName, role: user.role, status: p.status, statusSince: since };
    });

  return { configured: true, agents };
}

// Duration isn't something Webex's API exposes — it's derived from our own
// poll history: the first time we observe a given status for someone, we
// timestamp it, and every poll after that (while the status is unchanged)
// just reports elapsed time since. This means duration is only accurate
// from whenever this process last started — a deploy/restart resets the
// clock, which is an acceptable trade-off for a live dashboard indicator,
// not an audit record.
const statusSinceByEmail = new Map();
function recordStatusSince(email, status) {
  const prev = statusSinceByEmail.get(email);
  if (!prev || prev.status !== status) {
    statusSinceByEmail.set(email, { status, since: Date.now() });
    return Date.now();
  }
  return prev.since;
}

// Cache briefly so N browser tabs polling this page don't each trigger their
// own Webex API call — one real fetch serves everyone within the window.
let cachedResult = null;
let cachedAt = 0;
const CACHE_TTL_MS = 20 * 1000;

async function getAgentStatuses() {
  if (cachedResult && Date.now() - cachedAt < CACHE_TTL_MS) return cachedResult;
  const result = await fetchAgentStatuses();
  cachedResult = result;
  cachedAt = Date.now();
  return result;
}

module.exports = { isConfigured, getAgentStatuses };
