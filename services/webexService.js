const { getDb } = require('../db/database');
const { logActivity } = require('./activityLog');

const TOKEN_URL = 'https://webexapis.com/v1/access_token';
const PEOPLE_URL = 'https://webexapis.com/v1/people';
const ANALYTICS_API = 'https://analytics.webexapis.com/v1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  const matched = people.filter(p => p.email && byEmail.has(p.email.toLowerCase()));
  const sinceByEmail = await recordStatusSince(db, matched);

  const agents = matched.map(p => {
    const user = byEmail.get(p.email.toLowerCase());
    return { email: p.email, name: user.name || p.displayName, role: user.role, status: p.status, statusSince: sinceByEmail.get(p.email.toLowerCase()) };
  });

  return { configured: true, agents };
}

// Duration isn't something Webex's API exposes — it's derived from our own
// poll history, persisted in the DB (not memory) so a deploy/restart doesn't
// silently reset every agent's duration to zero. The first time we observe a
// given status for someone, we timestamp it; every poll after that, while
// the status is unchanged, just reports elapsed time since.
async function recordStatusSince(db, people) {
  const emails = people.map(p => p.email.toLowerCase());
  const existingRes = emails.length
    ? await db.execute({
        sql: `SELECT email, status, since FROM webex_agent_status_state WHERE email = ANY(?)`,
        args: [emails]
      })
    : { rows: [] };
  const existingByEmail = new Map(existingRes.rows.map(r => [String(r.email).toLowerCase(), r]));

  const result = new Map();
  for (const p of people) {
    const email = p.email.toLowerCase();
    const existing = existingByEmail.get(email);
    if (existing && existing.status === p.status) {
      result.set(email, Number(existing.since));
      continue;
    }
    const since = Date.now();
    result.set(email, since);
    await db.execute({
      sql: `INSERT INTO webex_agent_status_state (email, status, since, updated_at) VALUES (?, ?, ?, now())
            ON CONFLICT (email) DO UPDATE SET status = excluded.status, since = excluded.since, updated_at = now()`,
      args: [email, p.status, since]
    });
    // Close out whatever status period was open (if any — the very first
    // poll for someone won't have one) and open a new one, so the dashboard
    // can later ask "was this person on a call between X and Y".
    await db.execute({ sql: 'UPDATE webex_agent_status_history SET ended_at = now() WHERE email = ? AND ended_at IS NULL', args: [email] });
    await db.execute({ sql: 'INSERT INTO webex_agent_status_history (email, status, started_at) VALUES (?, ?, now())', args: [email, p.status] });
  }
  return result;
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

async function analyticsCall(path, params, accessToken) {
  const qs = new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${ANALYTICS_API}${path}?${qs}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Webex analytics API error (${path}): ${res.status} ${body.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`Webex analytics API error (${path}): too many rate-limit retries`);
}

const CDR_WINDOW_MS = 47 * 60 * 60 * 1000; // stay under Webex's documented 48h max window per request
const CDR_FRESHNESS_BUFFER_MS = 6 * 60 * 1000; // Webex needs ~5 min after a call ends before it's queryable

// Detailed Call History field names below are best-effort against Webex's
// documented column labels (confirmed via developer docs, not yet against a
// live response — this account didn't have calling_cdr_read scope until
// now). Every raw row is also stored in full in the `raw` column, so if the
// actual JSON keys turn out to be camelCase (or something else entirely)
// once real data comes through, the mapping below can be corrected without
// losing anything already synced.
function pickCdrField(row, ...candidates) {
  for (const c of candidates) if (row[c] !== undefined) return row[c];
  return null;
}

async function syncCallHistory(triggeredBy) {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error('Webex is not configured.');

  const db = getDb();
  const stateRes = await db.execute('SELECT last_synced_at FROM webex_cdr_sync_state WHERE id = 1');
  let windowStart = stateRes.rows[0]?.last_synced_at
    ? new Date(stateRes.rows[0].last_synced_at)
    : new Date(Date.now() - CDR_WINDOW_MS); // first sync: go back as far as Webex allows (~48h)
  const hardEnd = new Date(Date.now() - CDR_FRESHNESS_BUFFER_MS);

  const usersRes = await db.execute("SELECT email, name FROM users WHERE active = true");
  const byName = new Map(usersRes.rows.filter(u => u.name).map(u => [String(u.name).toLowerCase(), u.email]));

  let stored = 0;
  let scanned = 0;
  let newestEnd = windowStart;
  const errors = [];

  while (windowStart < hardEnd) {
    const windowEnd = new Date(Math.min(windowStart.getTime() + CDR_WINDOW_MS, hardEnd.getTime()));
    try {
      const data = await analyticsCall('/cdr_feed', {
        startTime: windowStart.toISOString().slice(0, 23) + 'Z',
        endTime: windowEnd.toISOString().slice(0, 23) + 'Z'
      }, accessToken);
      const items = data.items || [];
      scanned += items.length;
      for (const row of items) {
        try {
          const userName = pickCdrField(row, 'User', 'user');
          const userEmail = userName ? (byName.get(String(userName).toLowerCase()) || null) : null;
          await db.execute({
            sql: `INSERT INTO webex_cdrs
                  (start_time, answer_time, duration, ring_duration, calling_number, called_number, user_name, user_email, direction, call_type, answered, correlation_id, client_type, location, raw)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (start_time, calling_number, called_number, user_name) DO NOTHING`,
            args: [
              pickCdrField(row, 'Start time', 'startTime'),
              pickCdrField(row, 'Answer time', 'answerTime'),
              pickCdrField(row, 'Duration', 'duration'),
              pickCdrField(row, 'Ring duration', 'ringDuration'),
              pickCdrField(row, 'Calling number', 'callingNumber'),
              pickCdrField(row, 'Called number', 'calledNumber'),
              userName,
              userEmail,
              pickCdrField(row, 'Direction', 'direction'),
              pickCdrField(row, 'Call type', 'callType'),
              pickCdrField(row, 'Answered', 'answered'),
              pickCdrField(row, 'Correlation Id', 'correlationId'),
              pickCdrField(row, 'Client type', 'clientType'),
              pickCdrField(row, 'Location', 'location'),
              JSON.stringify(row)
            ]
          });
          stored++;
        } catch (err) {
          errors.push({ reason: err.message });
        }
      }
      newestEnd = windowEnd;
    } catch (err) {
      errors.push({ window: `${windowStart.toISOString()} - ${windowEnd.toISOString()}`, reason: err.message });
      break; // stop advancing past a failed window so a retry picks up from the same place
    }
    windowStart = windowEnd;
  }

  await db.execute({
    sql: `INSERT INTO webex_cdr_sync_state (id, last_synced_at, updated_at) VALUES (1, ?, now())
          ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at, updated_at = now()`,
    args: [newestEnd.toISOString()]
  });

  await logActivity('webex_cdr_sync', 'Webex call history sync', 'completed', `${stored} of ${scanned} CDR record${scanned !== 1 ? 's' : ''} stored (rest were duplicates already synced)`, triggeredBy);
  return { scanned, stored, errors, syncedThrough: newestEnd.toISOString() };
}

async function getCdrSyncStatus() {
  const db = getDb();
  const [stateRes, countRes] = await Promise.all([
    db.execute('SELECT last_synced_at FROM webex_cdr_sync_state WHERE id = 1'),
    db.execute('SELECT COUNT(*) AS count FROM webex_cdrs')
  ]);
  return {
    configured: isConfigured(),
    lastSyncedAt: stateRes.rows[0]?.last_synced_at || null,
    recordCount: Number(countRes.rows[0]?.count || 0)
  };
}

// Everything the Workforce Management Dashboard needs: per-rep call volume
// (in/out split), answered/missed rate, average handle time, and a
// presence-vs-CDR gap list — periods where someone's Webex status was "on a
// call" but no CDR record actually overlaps that window, worth a look since
// it can mean a stuck status, a dropped call that never logged, or a call
// on a channel this sync doesn't cover.
async function getWorkforceStats(rangeDays = 7) {
  const db = getDb();
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();

  const callsRes = await db.execute({
    sql: `SELECT user_email, user_name,
                 direction,
                 COUNT(*) AS call_count,
                 COUNT(*) FILTER (WHERE answered = true) AS answered_count,
                 COUNT(*) FILTER (WHERE answered = false) AS missed_count,
                 AVG(duration) FILTER (WHERE answered = true) AS avg_duration
          FROM webex_cdrs
          WHERE start_time >= ? AND user_name IS NOT NULL
          GROUP BY user_email, user_name, direction`,
    args: [since]
  });

  const byRep = new Map();
  for (const row of callsRes.rows) {
    const key = row.user_email || row.user_name;
    if (!byRep.has(key)) {
      byRep.set(key, {
        userEmail: row.user_email, userName: row.user_name,
        totalCalls: 0, inbound: 0, outbound: 0, answered: 0, missed: 0,
        durationSum: 0, durationCount: 0
      });
    }
    const rep = byRep.get(key);
    const count = Number(row.call_count);
    rep.totalCalls += count;
    if (row.direction === 'TERMINATING') rep.inbound += count;
    else if (row.direction === 'ORIGINATING') rep.outbound += count;
    rep.answered += Number(row.answered_count);
    rep.missed += Number(row.missed_count);
    if (row.avg_duration) {
      rep.durationSum += Number(row.avg_duration) * Number(row.answered_count);
      rep.durationCount += Number(row.answered_count);
    }
  }

  const reps = [...byRep.values()].map(r => {
    const decided = r.answered + r.missed;
    return {
      userEmail: r.userEmail, userName: r.userName,
      totalCalls: r.totalCalls, inbound: r.inbound, outbound: r.outbound,
      answeredCount: r.answered, missedCount: r.missed,
      answeredRate: decided > 0 ? Math.round((r.answered / decided) * 100) : null,
      missedRate: decided > 0 ? Math.round((r.missed / decided) * 100) : null,
      avgDurationSeconds: r.durationCount > 0 ? Math.round(r.durationSum / r.durationCount) : null
    };
  }).sort((a, b) => b.totalCalls - a.totalCalls);

  const gapsRes = await db.execute({
    sql: `SELECT h.email, h.started_at, h.ended_at,
                 EXTRACT(EPOCH FROM (h.ended_at - h.started_at)) AS gap_seconds
          FROM webex_agent_status_history h
          WHERE LOWER(h.status) = 'call' AND h.ended_at IS NOT NULL AND h.started_at >= ?
            AND NOT EXISTS (
              SELECT 1 FROM webex_cdrs c
              WHERE c.user_email = h.email
                AND c.start_time < h.ended_at
                AND (c.start_time + (COALESCE(c.duration, 0) || ' seconds')::interval) > h.started_at
            )
          ORDER BY h.started_at DESC LIMIT 50`,
    args: [since]
  });

  return { reps, gaps: gapsRes.rows, rangeDays };
}

module.exports = { isConfigured, getAgentStatuses, syncCallHistory, getCdrSyncStatus, getWorkforceStats };
