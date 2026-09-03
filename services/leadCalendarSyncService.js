const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { getCalendarClientFor, isConfigured: calendarConfigured, authMode } = require('./googleCalendarClient');

// Every calendarId below is the partner's own email, not the literal
// string 'primary'. For 'oauth' mode and 'delegation' mode (impersonation
// via subject:ownerEmail) these are equivalent — a Google Calendar user's
// own address always addresses their own primary calendar, same as
// 'primary' would. For 'service-account' mode (googleCalendarClient.js —
// no impersonation, just each partner manually sharing their calendar
// with the service account's own email, "Make changes to events") it's
// NOT equivalent: 'primary' there would resolve to the SERVICE ACCOUNT's
// own calendar, not the partner's — the explicit email is what actually
// targets their calendar. Using ownerEmail everywhere keeps this file
// identical across all three auth modes rather than branching per call site.

// ─── Partner ↔ calendar mapping ─────────────────────────────────────
// CALENDAR_PARTNER_MAP is a JSON object in .env: { "email": "partner name" },
// where "partner name" must exactly match the `assigned_workforce_partner`
// strings used elsewhere in the app (see WORKFORCE_PARTNER_OPTIONS in
// public/admin.html). Keeping the mapping in env rather than hardcoded here
// means adding/removing a partner's calendar never needs a code change.
//
// In oauth mode (CALENDAR_AUTH_MODE=oauth — see googleCalendarClient.js),
// this is instead built from calendar_oauth_connections, populated as each
// partner personally connects via routes/calendarSync.js's /connect flow —
// no env var to hand-maintain at all. Async now (the oauth path needs a
// DB query); every caller already awaits it.
async function getPartnerCalendarMap() {
  const envMap = (() => {
    if (!process.env.CALENDAR_PARTNER_MAP) return {};
    try {
      return JSON.parse(process.env.CALENDAR_PARTNER_MAP);
    } catch {
      console.warn('Calendar sync: CALENDAR_PARTNER_MAP is not valid JSON');
      return {};
    }
  })();
  if (authMode() !== 'oauth') return envMap;
  const rows = (await getDb().execute('SELECT google_email, partner_label FROM calendar_oauth_connections')).rows;
  const dbMap = {};
  for (const r of rows) dbMap[r.google_email] = r.partner_label;
  return { ...envMap, ...dbMap };
}

async function emailForPartner(partnerName) {
  const map = await getPartnerCalendarMap();
  return Object.keys(map).find(email => map[email] === partnerName) || null;
}

async function partnerForEmail(ownerEmail) {
  const map = await getPartnerCalendarMap();
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

// Most leads.centre_phone values are a bare number, but a few were typed
// in with the label already included (found while testing the .ics feed
// — real example: "Phone: (08) 8365 7571") — strips any such prefix so
// prepending our own "Phone: " label never doubles up either way.
function formatPhoneForDescription(phone) {
  return (phone || '').replace(/^\s*(phone|ph)\s*:\s*/i, '').trim();
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
    const ownerEmail = await emailForPartner(lead.assigned_workforce_partner);
    if (!ownerEmail) return; // no calendar mapped for this partner yet

    const scheduledAt = eventType === 'call' ? lead.lead_called_at : lead.centre_visited_at;
    if (!scheduledAt) return;

    const calendar = await getCalendarClientFor(ownerEmail);
    if (!calendar) return;

    const start = new Date(scheduledAt);
    const durationMinutes = eventType === 'call' ? 30 : 45;
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    const requestBody = {
      summary: buildEventTitle(eventType, lead.centre_name),
      description: [
        lead.street_address ? `Address: ${lead.street_address}${lead.suburb ? ', ' + lead.suburb : ''}${lead.state ? ' ' + lead.state : ''}` : null,
        lead.centre_phone ? `Phone: ${formatPhoneForDescription(lead.centre_phone)}` : null,
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
      await calendar.events.update({ calendarId: ownerEmail, eventId: existing.rows[0].google_event_id, requestBody });
      await getDb().execute({
        sql: `UPDATE lead_calendar_events SET updated_at = now() WHERE id = ?`,
        args: [existing.rows[0].id]
      });
    } else {
      const created = await calendar.events.insert({ calendarId: ownerEmail, requestBody });
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
  // Smart Routing's lunch break isn't tied to any lead — just skip it
  // rather than sending it through fuzzy-matching (it has no bracket tag
  // for classifyAndStripTitle to key off, so it'd otherwise land in the
  // review queue every time it's echoed back).
  if (rawProps.rawtalentEventType === 'lunch') return;
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
  const ownerPartnerName = await partnerForEmail(ownerEmail);

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
  const calendar = await getCalendarClientFor(ownerEmail);
  if (!calendar) return;

  const db = getDb();
  const stateRes = await db.execute({ sql: 'SELECT * FROM calendar_watch_state WHERE calendar_owner_email = ?', args: [ownerEmail] });
  let syncToken = stateRes.rows[0]?.sync_token || null;

  let pageToken;
  let newSyncToken;
  try {
    do {
      const params = { calendarId: ownerEmail, maxResults: 250, pageToken };
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
  const calendar = await getCalendarClientFor(ownerEmail);
  if (!calendar) return;

  const db = getDb();
  const channelId = uuidv4();
  const res = await calendar.events.watch({
    calendarId: ownerEmail,
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
  const partners = Object.keys(await getPartnerCalendarMap());
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

// Pushes a Smart Routing itinerary (see services/routeOptimizerService.js)
// onto one partner's calendar: one [Centre Visit] event per stop (also
// flips that lead's centre-visited status to 'scheduled', same as the
// single-lead outbound sync — or logs a 'planned' centre_visits row for a
// My Centres stop, see below) plus one plain event for the lunch break.
// `blocks` are the itinerary blocks from buildItinerary() — 'visit' blocks
// carry the full stop object (a lead row OR a routes/centres.js routing-
// stop, tagged `type`) as `stop`, 'lunch' blocks don't touch either.
// `actor` ({email, name} = req.user) attributes a centre_visits row to
// whoever actually built the route, same convention as every other
// centre_visits write in the app (e.g. Centre 360's Log Visit).
async function syncRouteToCalendar(ownerEmail, blocks, actor) {
  if (!calendarConfigured()) throw new Error('Google Calendar is not configured');
  const calendar = await getCalendarClientFor(ownerEmail);
  if (!calendar) throw new Error(`Could not build a calendar client for ${ownerEmail}`);

  const db = getDb();
  const created = [];
  const actorEmail = actor?.email || ownerEmail;
  const actorName = actor?.name || actorEmail;

  for (const block of blocks) {
    if (block.type === 'visit') {
      const stop = block.stop;
      const isCentre = stop.type === 'centre';
      const requestBody = {
        summary: buildEventTitle('visit', stop.centre_name),
        location: [stop.street_address, stop.suburb, stop.state].filter(Boolean).join(', '),
        description: isCentre
          ? `Smart Routing visit — HeartBeat centre: ${process.env.APP_URL || ''}/admin?centre=${encodeURIComponent(stop.id)}`
          : `Smart Routing visit — HeartBeat lead: ${process.env.APP_URL || ''}/admin?lead=${stop.id}`,
        start: { dateTime: new Date(block.start).toISOString() },
        end: { dateTime: new Date(block.end).toISOString() },
        extendedProperties: {
          private: isCentre
            ? { rawtalentCentreKey: stop.id, rawtalentEventType: 'visit' }
            : { rawtalentLeadId: stop.id, rawtalentEventType: 'visit' }
        }
      };
      const res = await calendar.events.insert({ calendarId: ownerEmail, requestBody });

      if (isCentre) {
        // Logged as PLANNED, not completed — lastVisitDate() (see
        // centreHealthService.js) only counts status==='completed', so
        // scheduling this on a calendar deliberately does NOT flip the
        // centre's nurture status to on_track by itself; that only
        // happens once someone marks the actual visit done (Centre 360's
        // existing Log Visit flow, or a recording/transcript upload).
        await db.execute({
          sql: `INSERT INTO centre_visits (id, centre_key, visit_date, status, purpose, notes, created_by_email, created_by_name)
                VALUES (?, ?, ?, 'planned', 'Smart Routing visit', ?, ?, ?)`,
          args: [uuidv4(), stop.id, new Date(block.start).toISOString(), 'Scheduled via Smart Routing.', actorEmail, actorName]
        });
        created.push({ centreKey: stop.id, eventId: res.data.id, type: 'visit' });
      } else {
        await db.execute({
          sql: `INSERT INTO lead_calendar_events (id, lead_id, event_type, google_event_id, calendar_owner_email, source)
                VALUES (?, ?, 'visit', ?, ?, 'app')`,
          args: [uuidv4(), stop.id, res.data.id, ownerEmail]
        });
        await db.execute({
          sql: `UPDATE leads SET centre_visited_status = 'scheduled', centre_visited_at = ?, updated_at = now() WHERE id = ?`,
          args: [new Date(block.start).toISOString(), stop.id]
        });
        created.push({ leadId: stop.id, eventId: res.data.id, type: 'visit' });
      }
    } else if (block.type === 'lunch') {
      const requestBody = {
        summary: block.label || 'Lunch & Admin Break',
        start: { dateTime: new Date(block.start).toISOString() },
        end: { dateTime: new Date(block.end).toISOString() },
        extendedProperties: { private: { rawtalentEventType: 'lunch' } }
      };
      const res = await calendar.events.insert({ calendarId: ownerEmail, requestBody });
      created.push({ eventId: res.data.id, type: 'lunch' });
    }
  }

  return created;
}

// ─── Read-only .ics subscription feed ────────────────────────────────
// See db/schema.sql's comment on calendar_feed_tokens for the "why" —
// this sidesteps Google's OAuth/service-account/API surface entirely.
// Each partner subscribes to their own private URL directly from their
// Google Calendar's own "Add calendar → From URL" (or the one-click
// calendar.google.com/render?cid= link built in routes/calendarSync.js).
// One-way (HeartBeat → their calendar), refreshed periodically by
// Google rather than live — the trade-off for zero Google-side setup.
async function getOrCreateFeedToken(partnerLabel) {
  const existing = await getDb().execute({ sql: 'SELECT token FROM calendar_feed_tokens WHERE partner_label = ?', args: [partnerLabel] });
  if (existing.rows[0]) return existing.rows[0].token;
  // Generate-then-insert-ignore-then-reread rather than trusting our own
  // generated value, in case of a concurrent first-request race between
  // two tabs both hitting "get my link" for the same partner at once.
  await getDb().execute({
    sql: `INSERT INTO calendar_feed_tokens (partner_label, token) VALUES (?, ?) ON CONFLICT (partner_label) DO NOTHING`,
    args: [partnerLabel, crypto.randomBytes(24).toString('hex')]
  });
  const row = await getDb().execute({ sql: 'SELECT token FROM calendar_feed_tokens WHERE partner_label = ?', args: [partnerLabel] });
  return row.rows[0].token;
}

// The token IS the credential (no session cookie arrives here — Google's
// subscription fetcher is an anonymous HTTP client) — this is the only
// lookup the public /feed/:token route does, deliberately not also
// trusting a partner label supplied in the URL itself.
async function partnerLabelForFeedToken(token) {
  const row = await getDb().execute({ sql: 'SELECT partner_label FROM calendar_feed_tokens WHERE token = ?', args: [token] });
  return row.rows[0]?.partner_label || null;
}

// Invalidates the old link (e.g. if it leaked) — old URL 404s immediately,
// a fresh one has to be fetched and re-subscribed to.
async function regenerateFeedToken(partnerLabel) {
  const token = crypto.randomBytes(24).toString('hex');
  await getDb().execute({
    sql: `INSERT INTO calendar_feed_tokens (partner_label, token) VALUES (?, ?)
          ON CONFLICT (partner_label) DO UPDATE SET token = excluded.token, created_at = now()`,
    args: [partnerLabel, token]
  });
  return token;
}

// RFC 5545 TEXT escaping — backslash, semicolon, comma, and embedded
// newlines all need escaping inside a property value.
function icsEscapeText(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDateTimeUtc(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// RFC 5545 line folding: no content line may exceed 75 octets: split at
// 75, continuation lines start with a single space. Most calendar apps
// tolerate long lines anyway, but Google Calendar is the one client
// this feed is actually built for, worth doing properly rather than
// hoping it's lenient.
function icsFold(line) {
  if (line.length <= 75) return line;
  const chunks = [];
  let rest = line;
  while (rest.length > 75) {
    chunks.push(rest.slice(0, 75));
    rest = rest.slice(75);
  }
  chunks.push(rest);
  return chunks.map((c, i) => (i === 0 ? c : ' ' + c)).join('\r\n');
}

// One partner's scheduled leads calls/visits, as a snapshot .ics document
// — same trigger condition syncLeadEventOutbound uses (status='scheduled'
// plus a real timestamp), just read instead of pushed live. Smart
// Routing's centre-visit/lunch blocks (syncRouteToCalendar) aren't
// included yet — a natural follow-up using this same shape, not
// attempted here.
async function buildIcsFeed(partnerLabel) {
  const leads = (await getDb().execute({
    sql: `SELECT id, centre_name, street_address, suburb, state, centre_phone,
                 lead_called_status, lead_called_at, centre_visited_status, centre_visited_at
          FROM leads WHERE assigned_workforce_partner = ?`,
    args: [partnerLabel]
  })).rows;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RawTalent HeartBeat//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscapeText(`${partnerLabel} — HeartBeat`)}`,
    // Both are hints, not guarantees — Google Calendar decides its own
    // actual poll interval for subscribed URLs regardless.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];

  const now = icsDateTimeUtc(new Date());
  for (const lead of leads) {
    for (const eventType of ['call', 'visit']) {
      const status = eventType === 'call' ? lead.lead_called_status : lead.centre_visited_status;
      const scheduledAt = eventType === 'call' ? lead.lead_called_at : lead.centre_visited_at;
      if (status !== 'scheduled' || !scheduledAt) continue;

      const start = new Date(scheduledAt);
      const durationMinutes = eventType === 'call' ? 30 : 45;
      const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
      const location = [lead.street_address, lead.suburb, lead.state].filter(Boolean).join(', ');
      const description = [
        lead.centre_phone ? `Phone: ${formatPhoneForDescription(lead.centre_phone)}` : null,
        `HeartBeat lead: ${process.env.APP_URL || ''}/admin?lead=${lead.id}`
      ].filter(Boolean).join('\n');

      lines.push(
        'BEGIN:VEVENT',
        `UID:heartbeat-${eventType}-${lead.id}@rawtalent-internal.app`,
        `DTSTAMP:${now}`,
        `DTSTART:${icsDateTimeUtc(start)}`,
        `DTEND:${icsDateTimeUtc(end)}`,
        `SUMMARY:${icsEscapeText(buildEventTitle(eventType, lead.centre_name))}`
      );
      if (location) lines.push(`LOCATION:${icsEscapeText(location)}`);
      lines.push(`DESCRIPTION:${icsEscapeText(description)}`, 'END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

module.exports = {
  getPartnerCalendarMap,
  emailForPartner,
  partnerForEmail,
  buildEventTitle,
  classifyAndStripTitle,
  syncLeadEventOutbound,
  syncRouteToCalendar,
  processInboundEvent,
  listAndApplyChanges,
  registerOrRenewWatch,
  renewWatchesNearingExpiry,
  getOrCreateFeedToken,
  partnerLabelForFeedToken,
  regenerateFeedToken,
  buildIcsFeed
};
