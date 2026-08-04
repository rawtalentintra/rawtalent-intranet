const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { getCalendarClientFor, isConfigured: calendarConfigured } = require('./googleCalendarClient');

// ─── Partner ↔ calendar mapping ─────────────────────────────────────
// CALENDAR_PARTNER_MAP is a JSON object in .env: { "email": "partner name" },
// where "partner name" must exactly match the `assigned_workforce_partner`
// strings used elsewhere in the app (see WORKFORCE_PARTNER_OPTIONS in
// public/admin.html). Keeping the mapping in env rather than hardcoded here
// means adding/removing a partner's calendar never needs a code change.
function getPartnerCalendarMap() {
  if (!process.env.CALENDAR_PARTNER_MAP) return {};
  try {
    return JSON.parse(process.env.CALENDAR_PARTNER_MAP);
  } catch {
    console.warn('Calendar sync: CALENDAR_PARTNER_MAP is not valid JSON');
    return {};
  }
}

function emailForPartner(partnerName) {
  const map = getPartnerCalendarMap();
  return Object.keys(map).find(email => map[email] === partnerName) || null;
}

function partnerForEmail(ownerEmail) {
  const map = getPartnerCalendarMap();
  return map[ownerEmail] || null;
}

// ─── Event classification (naming convention) ───────────────────────
// Authoritative signal for events HeartBeat itself created: extendedProperties
// .private.rawtalentEventType ('call'|'visit') + rawtalentLeadId. Google
// always returns these back on the same event, so an app-created event is
// recognized with certainty and never re-parsed from its title.
//
// For events a Workforce Partner types by hand, the title carries the
// signal: a leading bracket tag matching the app's own status terminology
// ("Lead Called" / "Centre Visited"):
//   [Lead Call] Headstart Hughesdale
//   [Centre Visit] Goodstart Early Learning Camberwell
// A freehand fallback (no brackets) also recognizes a bare "call" or
// "visit"/"site visit" keyword anywhere in the title, stripped before
// matching so it doesn't pollute the fuzzy-match against centre_name.
const EVENT_TAG = { call: 'Lead Call', visit: 'Centre Visit' };

function buildEventTitle(eventType, centreName) {
  return `[${EVENT_TAG[eventType]}] ${centreName}`;
}

const BRACKET_TAG_RE = /^\s*\[(lead call|call|centre visit|site visit|visit)\]\s*/i;
const FREEHAND_CALL_RE = /\b(phone call|call)\b/i;
const FREEHAND_VISIT_RE = /\b(site visit|centre visit|visit)\b/i;

function classifyAndStripTitle(rawTitle) {
  const title = (rawTitle || '').trim();

  const bracketMatch = title.match(BRACKET_TAG_RE);
  if (bracketMatch) {
    const tag = bracketMatch[1].toLowerCase();
    const eventType = tag.includes('visit') ? 'visit' : 'call';
    return { eventType, strippedTitle: title.slice(bracketMatch[0].length).trim() };
  }

  // Freehand fallback — check visit first since "site visit" also contains
  // no "call" text, and a title mentioning both is genuinely ambiguous
  // (rare enough to just fall to visit, the less error-prone default: a
  // missed call is easy to re-schedule, a missed visit less so).
  if (FREEHAND_VISIT_RE.test(title)) {
    return { eventType: 'visit', strippedTitle: title.replace(FREEHAND_VISIT_RE, '').replace(/\s{2,}/g, ' ').trim() };
  }
  if (FREEHAND_CALL_RE.test(title)) {
    return { eventType: 'call', strippedTitle: title.replace(FREEHAND_CALL_RE, '').replace(/\s{2,}/g, ' ').trim() };
  }

  return { eventType: null, strippedTitle: title };
}

// ─── Fuzzy match a (stripped) title against leads ───────────────────
// Scoped to the calendar owner's own assigned leads whenever we know who
// that is — narrowing the candidate pool this way is what makes 0.4 a safe
// threshold instead of a recipe for cross-partner false positives.
// Returns { best, second } where each is { lead, score } or undefined.
async function findLeadCandidates(strippedTitle, ownerPartnerName) {
  if (!strippedTitle || strippedTitle.length < 3) return {};

  const args = [strippedTitle, strippedTitle];
  let partnerFilter = '';
  if (ownerPartnerName) {
    partnerFilter = 'AND assigned_workforce_partner = ?';
    args.push(ownerPartnerName);
  }

  const result = await getDb().execute({
    sql: `SELECT id, centre_name, assigned_workforce_partner, lead_called_status, centre_visited_status,
                 similarity(lower(centre_name), lower(?)) AS score
          FROM leads
          WHERE similarity(lower(centre_name), lower(?)) > 0.4 ${partnerFilter}
          ORDER BY score DESC LIMIT 2`,
    args
  });

  const [best, second] = result.rows;
  return { best, second };
}

const CALENDAR_MATCH_AMBIGUOUS_GAP = 0.05;

// ─── Outbound: HeartBeat → Google Calendar ───────────────────────────
// Fire-and-forget from routes/leads.js whenever a lead's call/visit is set
// to 'scheduled' with a timestamp and an assigned partner. Never throws —
// a calendar hiccup should never fail the status update itself.
async function syncLeadEventOutbound(lead, eventType) {
  try {
    if (!calendarConfigured()) return;
    const ownerEmail = emailForPartner(lead.assigned_workforce_partner);
    if (!ownerEmail) return; // no calendar mapped for this partner yet

    const scheduledAt = eventType === 'call' ? lead.lead_called_at : lead.centre_visited_at;
    if (!scheduledAt) return;

    const calendar = getCalendarClientFor(ownerEmail);
    if (!calendar) return;

    const start = new Date(scheduledAt);
    const durationMinutes = eventType === 'call' ? 30 : 45;
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    const requestBody = {
      summary: buildEventTitle(eventType, lead.centre_name),
      description: [
        lead.street_address ? `Address: ${lead.street_address}${lead.suburb ? ', ' + lead.suburb : ''}${lead.state ? ' ' + lead.state : ''}` : null,
        lead.centre_phone ? `Phone: ${lead.centre_phone}` : null,
        lead.agency_usage ? `Agency usage: ${lead.agency_usage}` : null,
        `HeartBeat lead: ${process.env.APP_URL || ''}/admin?lead=${lead.id}`
      ].filter(Boolean).join('\n'),
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      extendedProperties: { private: { rawtalentLeadId: lead.id, rawtalentEventType: eventType } }
    };

    const existing = await getDb().execute({
      sql: `SELECT * FROM lead_calendar_events WHERE lead_id = ? AND event_type = ? AND source = 'app'`,
      args: [lead.id, eventType]
    });

    if (existing.rows[0]) {
      await calendar.events.update({ calendarId: 'primary', eventId: existing.rows[0].google_event_id, requestBody });
      await getDb().execute({
        sql: `UPDATE lead_calendar_events SET updated_at = now() WHERE id = ?`,
        args: [existing.rows[0].id]
      });
    } else {
      const created = await calendar.events.insert({ calendarId: 'primary', requestBody });
      await getDb().execute({
        sql: `INSERT INTO lead_calendar_events (id, lead_id, event_type, google_event_id, calendar_owner_email, source)
              VALUES (?, ?, ?, ?, ?, 'app')`,
        args: [uuidv4(), lead.id, eventType, created.data.id, ownerEmail]
      });
    }
  } catch (err) {
    console.error(`Calendar outbound sync error (lead ${lead.id}, ${eventType}):`, err.message);
  }
}

// ─── Inbound: Google Calendar → HeartBeat ────────────────────────────
async function processInboundEvent(event, ownerEmail) {
  const db = getDb();

  if (event.status === 'cancelled') {
    await db.execute({ sql: `DELETE FROM lead_calendar_events WHERE google_event_id = ? AND calendar_owner_email = ?`, args: [event.id, ownerEmail] });
    return;
  }

  const rawProps = event.extendedProperties?.private || {};
  if (rawProps.rawtalentLeadId) {
    // Our own app-created event echoed back — nothing to infer, just make
    // sure the bookkeeping row exists (covers events created before this
    // service existed, or a missed insert).
    await db.execute({
      sql: `INSERT INTO lead_calendar_events (id, lead_id, event_type, google_event_id, calendar_owner_email, source)
            VALUES (?, ?, ?, ?, ?, 'app')
            ON CONFLICT (google_event_id, calendar_owner_email) DO NOTHING`,
      args: [uuidv4(), rawProps.rawtalentLeadId, rawProps.rawtalentEventType || 'call', event.id, ownerEmail]
    });
    return;
  }

  const title = event.summary || '';
  const { eventType, strippedTitle } = classifyAndStripTitle(title);
  const ownerPartnerName = partnerForEmail(ownerEmail);

  const reject = async (reason, candidate) => {
    await db.execute({
      sql: `INSERT INTO calendar_sync_review_queue
              (id, google_event_id, calendar_owner_email, event_title, event_type, candidate_lead_id, candidate_score, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [uuidv4(), event.id, ownerEmail, title, eventType, candidate?.lead?.id || null, candidate?.lead?.score ?? null, reason]
    });
  };

  if (!eventType) return reject('No Call/Visit tag or keyword found in the event title');

  const { best, second } = await findLeadCandidates(strippedTitle, ownerPartnerName);
  if (!best) return reject('No lead matched this title closely enough');
  if (second && best.score - second.score < CALENDAR_MATCH_AMBIGUOUS_GAP) {
    return reject(`Ambiguous — "${best.centre_name}" (${best.score.toFixed(2)}) vs "${second.centre_name}" (${second.score.toFixed(2)})`, { lead: best });
  }

  const startTime = event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00` : null);
  if (!startTime) return reject('Event has no start time to schedule from', { lead: best });

  const statusColumn = eventType === 'call' ? 'lead_called_status' : 'centre_visited_status';
  const atColumn = eventType === 'call' ? 'lead_called_at' : 'centre_visited_at';
  await db.execute({
    sql: `UPDATE leads SET ${statusColumn} = 'scheduled', ${atColumn} = ?,
            assigned_workforce_partner = COALESCE(assigned_workforce_partner, ?), updated_at = now()
          WHERE id = ?`,
    args: [startTime, ownerPartnerName, best.id]
  });

  await db.execute({
    sql: `INSERT INTO lead_calendar_events (id, lead_id, event_type, google_event_id, calendar_owner_email, source)
          VALUES (?, ?, ?, ?, ?, 'calendar')
          ON CONFLICT (google_event_id, calendar_owner_email)
          DO UPDATE SET lead_id = EXCLUDED.lead_id, event_type = EXCLUDED.event_type, updated_at = now()`,
    args: [uuidv4(), best.id, eventType, event.id, ownerEmail]
  });
}

// Incremental fetch since the stored sync_token; a 410 means the token
// expired (Google keeps them for a few months) and requires a fresh
// baseline — handled by dropping the token and re-listing from now(),
// rather than walking the partner's entire calendar history.
async function listAndApplyChanges(ownerEmail) {
  if (!calendarConfigured()) return;
  const calendar = getCalendarClientFor(ownerEmail);
  if (!calendar) return;

  const db = getDb();
  const stateRes = await db.execute({ sql: 'SELECT * FROM calendar_watch_state WHERE calendar_owner_email = ?', args: [ownerEmail] });
  let syncToken = stateRes.rows[0]?.sync_token || null;

  let pageToken;
  let newSyncToken;
  try {
    do {
      const params = { calendarId: 'primary', maxResults: 250, pageToken };
      if (syncToken) params.syncToken = syncToken;
      else params.timeMin = new Date().toISOString(); // first-ever run: don't walk history

      const res = await calendar.events.list(params);
      for (const event of res.data.items || []) {
        await processInboundEvent(event, ownerEmail).catch(err =>
          console.error(`Calendar inbound sync error (event ${event.id}):`, err.message));
      }
      pageToken = res.data.nextPageToken;
      if (res.data.nextSyncToken) newSyncToken = res.data.nextSyncToken;
    } while (pageToken);
  } catch (err) {
    if (err.code === 410) {
      await db.execute({ sql: `UPDATE calendar_watch_state SET sync_token = NULL WHERE calendar_owner_email = ?`, args: [ownerEmail] });
      return listAndApplyChanges(ownerEmail); // retry once, fresh baseline
    }
    throw err;
  }

  if (newSyncToken) {
    await db.execute({
      sql: `INSERT INTO calendar_watch_state (calendar_owner_email, sync_token)
            VALUES (?, ?)
            ON CONFLICT (calendar_owner_email) DO UPDATE SET sync_token = EXCLUDED.sync_token, updated_at = now()`,
      args: [ownerEmail, newSyncToken]
    });
  }
}

// Google Calendar push-notification channels expire (max ~30 days) and
// must be re-registered before then, or the webhook silently stops firing.
async function registerOrRenewWatch(ownerEmail) {
  if (!calendarConfigured() || !process.env.APP_URL) return;
  const calendar = getCalendarClientFor(ownerEmail);
  if (!calendar) return;

  const db = getDb();
  const channelId = uuidv4();
  const res = await calendar.events.watch({
    calendarId: 'primary',
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: `${process.env.APP_URL}/api/calendar-sync/webhook`,
      token: ownerEmail
    }
  });

  await db.execute({
    sql: `INSERT INTO calendar_watch_state (calendar_owner_email, channel_id, resource_id, channel_expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (calendar_owner_email) DO UPDATE SET channel_id = EXCLUDED.channel_id,
            resource_id = EXCLUDED.resource_id, channel_expires_at = EXCLUDED.channel_expires_at, updated_at = now()`,
    args: [ownerEmail, res.data.id, res.data.resourceId, res.data.expiration ? new Date(Number(res.data.expiration)) : null]
  });
}

async function renewWatchesNearingExpiry() {
  if (!calendarConfigured()) return;
  const partners = Object.keys(getPartnerCalendarMap());
  const db = getDb();
  for (const ownerEmail of partners) {
    try {
      const stateRes = await db.execute({ sql: 'SELECT channel_expires_at FROM calendar_watch_state WHERE calendar_owner_email = ?', args: [ownerEmail] });
      const expiresAt = stateRes.rows[0]?.channel_expires_at;
      const needsRenewal = !expiresAt || new Date(expiresAt).getTime() - Date.now() < 48 * 60 * 60 * 1000;
      if (needsRenewal) await registerOrRenewWatch(ownerEmail);
    } catch (err) {
      console.error(`Calendar watch renewal error (${ownerEmail}):`, err.message);
    }
  }
}

module.exports = {
  getPartnerCalendarMap,
  emailForPartner,
  partnerForEmail,
  buildEventTitle,
  classifyAndStripTitle,
  syncLeadEventOutbound,
  processInboundEvent,
  listAndApplyChanges,
  registerOrRenewWatch,
  renewWatchesNearingExpiry
};
