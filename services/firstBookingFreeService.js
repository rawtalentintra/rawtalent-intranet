// First Booking Free (Liam, 15 Oct 2026). See db/schema.sql's
// first_booking_free_offers. Three jobs:
//  1. sendOfferEmail — tells Customer.io (profile attributes + event) so its
//     First Booking Free automation emails the centre contact. Behind the
//     FBF_CIO_ENABLED flag (see cioTrackConfig); until on, offers stay 'pending'.
//  2. processFirstBookings — when the tagged centre's first booking after the
//     offer appears in RT, create one task for Nancy (accounts) to not charge it.
//  3. resolveCentreKey — a lead is tied to its RT centre by phone/email match.
// Reads RT only; never writes to RT.
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { getCentresAndBookings } = require('../routes/centres');
const centreMatchService = require('./centreMatchService');

const NANCY = 'accounts@rawtalent.com.au';
const LIVE_BOOKING_STATUSES = new Set([1, 2, 3, 5]); // open, requested, assigned, completed

// Customer.io signal (Liam, Weekly Growth & Product Sync 15 Oct): tagging starts
// the multi-email First Booking Free automation in Customer.io, so HeartBeat
// updates the contact's profile and fires an event instead of a single
// transactional send. OFF until Joy sets FBF_CIO_ENABLED=true in Railway; also
// needs the Track API credentials CUSTOMERIO_SITE_ID + CUSTOMERIO_TRACK_API_KEY
// (CUSTOMERIO_REGION=eu only if the workspace is in the EU region). While off
// or unconfigured, offers stay 'pending' and nothing leaves HeartBeat.
function cioTrackConfig() {
  const enabled = String(process.env.FBF_CIO_ENABLED || '').toLowerCase() === 'true';
  const siteId = process.env.CUSTOMERIO_SITE_ID, key = process.env.CUSTOMERIO_TRACK_API_KEY;
  const host = String(process.env.CUSTOMERIO_REGION || '').toLowerCase() === 'eu' ? 'https://track-eu.customer.io' : 'https://track.customer.io';
  return { enabled, ready: enabled && !!siteId && !!key, siteId, key, host };
}

// Customer.io identifies RT clients by RT person id (the client's
// primaryUserId), so profiles are addressed as customers/{personId}. If HeartBeat
// can't tie the offer to an RT client, it looks the email up in Customer.io
// (App API) and uses cio_<cio_id>. It never creates a profile by email: that
// would clash with RT Portal's own identify later. No profile → 'no_profile',
// retried by the scheduled job. One event per person per centre.
async function cioIdentifierFor(o, ct) {
  if (ct && ct.rtPersonId) return String(ct.rtPersonId);
  const appKey = process.env.CUSTOMERIO_APP_API_KEY;
  if (!appKey || !o.contact_email) return null;
  const r = await fetch(`https://api.customer.io/v1/customers?email=${encodeURIComponent(o.contact_email)}`, { headers: { Authorization: `Bearer ${appKey}` } });
  if (!r.ok) throw new Error(`Customer.io lookup ${r.status}`);
  const d = await r.json();
  const hit = (d.results || [])[0];
  return hit && hit.cio_id ? `cio_${hit.cio_id}` : null;
}

async function sendOfferEmail(offerId) {
  const db = getDb();
  const o = (await db.execute({ sql: 'SELECT * FROM first_booking_free_offers WHERE id = ?', args: [offerId] })).rows[0];
  if (!o || ['sent', 'duplicate'].includes(o.email_status)) return o && o.email_status;
  const cfg = cioTrackConfig();
  if (!cfg.ready) return 'pending'; // flag off or credentials missing — retried by the scheduled job
  try {
    const ct = await resolveContact({ leadId: o.lead_id, centreKey: o.centre_key });
    const ident = await cioIdentifierFor(o, ct);
    if (!ident) {
      await db.execute({ sql: "UPDATE first_booking_free_offers SET email_status = ? WHERE id = ?", args: [o.contact_email || (ct && ct.rtPersonId) ? 'no_profile' : 'no_email', offerId] });
      return 'no_profile';
    }
    const centreKey = (ct && ct.centreKey) || o.centre_key || `lead:${o.lead_id}`;
    const dup = (await db.execute({ sql: "SELECT 1 FROM first_booking_free_offers WHERE id <> ? AND email_status = 'sent' AND cio_identifier = ? AND cio_centre_key = ?", args: [offerId, ident, centreKey] })).rows[0];
    if (dup) {
      await db.execute({ sql: "UPDATE first_booking_free_offers SET email_status = 'duplicate', cio_identifier = ?, cio_centre_key = ? WHERE id = ?", args: [ident, centreKey, offerId] });
      return 'duplicate';
    }
    const auth = 'Basic ' + Buffer.from(`${cfg.siteId}:${cfg.key}`).toString('base64');
    const base = `${cfg.host}/api/v1/customers/${encodeURIComponent(ident)}`;
    const headers = { Authorization: auth, 'Content-Type': 'application/json' };
    const data = { centre_name: o.centre_name, centre_key: centreKey, state: o.state || '', partner_name: o.offered_by_name || '', contact_first_name: o.contact_first_name || '' };
    const r1 = await fetch(base, { method: 'PUT', headers, body: JSON.stringify({
      first_booking_free: true, first_booking_free_tagged_at: Math.floor(new Date(o.offered_at).getTime() / 1000),
      fbf_centre_name: data.centre_name, fbf_centre_key: centreKey, fbf_state: data.state, fbf_partner_name: data.partner_name
    }) });
    if (!r1.ok) throw new Error(`Customer.io profile ${r1.status}: ${(await r1.text()).slice(0, 200)}`);
    const r2 = await fetch(`${base}/events`, { method: 'POST', headers, body: JSON.stringify({ name: 'first_booking_free_tagged', data }) });
    if (!r2.ok) throw new Error(`Customer.io event ${r2.status}: ${(await r2.text()).slice(0, 200)}`);
    await db.execute({ sql: "UPDATE first_booking_free_offers SET email_status = 'sent', email_sent_at = now(), email_error = NULL, cio_identifier = ?, cio_centre_key = ? WHERE id = ?", args: [ident, centreKey, offerId] });
    return 'sent';
  } catch (err) {
    await db.execute({ sql: "UPDATE first_booking_free_offers SET email_status = 'failed', email_error = ? WHERE id = ?", args: [String(err.message).slice(0, 300), offerId] });
    return 'failed';
  }
}

// Who the offer goes to. Leads are tied to their RT centre when one matches;
// an RT centre's profile is its client's primary user (RT person id).
const shortState = s => ({ victoria: 'VIC', 'south australia': 'SA', queensland: 'QLD', 'new south wales': 'NSW', 'australian capital territory': 'ACT', 'northern territory': 'NT' })[String(s || '').trim().toLowerCase()] || String(s || '').trim().toUpperCase() || null;
async function resolveContact({ leadId, centreKey }) {
  const { centres, rawClients } = await getCentresAndBookings();
  const fromCentre = (c, extra = {}) => {
    const client = rawClients.find(x => String(x.clientId) === String(c.rtClientId));
    return { centreName: c.name, centreKey: c.centreKey, email: (client && client.email) || c.email || null, firstName: (c.contactName || '').split(' ')[0] || null, name: c.contactName || null, state: shortState(c.state), rtPersonId: client && client.primaryUserId ? String(client.primaryUserId) : null, ...extra };
  };
  if (leadId) {
    const l = (await getDb().execute({ sql: 'SELECT id, centre_name, centre_phone, contact_email, contact_first_name, contact_last_name, suburb, state FROM leads WHERE id = ?', args: [leadId] })).rows[0];
    if (!l) return null;
    const m = centreMatchService.findConfidentMatch(l, rawClients);
    const key = m ? (m.rtLocationId ? `loc:${m.rtLocationId}` : `client:${m.rtClientId}`) : null;
    const c = key && centres.find(x => x.centreKey === key);
    if (c) return fromCentre(c, { centreName: l.centre_name || c.name });
    return { centreName: l.centre_name, centreKey: null, email: l.contact_email || null, firstName: l.contact_first_name || null, name: [l.contact_first_name, l.contact_last_name].filter(Boolean).join(' ') || null, state: shortState(l.state), rtPersonId: null };
  }
  const c = centres.find(x => x.centreKey === centreKey);
  return c ? fromCentre(c) : null;
}

async function resolveCentreKey(o, rawClients) {
  if (o.centre_key) return o.centre_key;
  if (!o.lead_id) return null;
  const lead = (await getDb().execute({ sql: 'SELECT id, centre_name, centre_phone, contact_email, suburb, state FROM leads WHERE id = ?', args: [o.lead_id] })).rows[0];
  const m = lead && centreMatchService.findConfidentMatch(lead, rawClients);
  return m ? (m.rtLocationId ? `loc:${m.rtLocationId}` : `client:${m.rtClientId}`) : null;
}

async function processFirstBookings() {
  const db = getDb();
  // retry emails that couldn't go yet
  const pendingEmails = (await db.execute({ sql: "SELECT id FROM first_booking_free_offers WHERE email_status IN ('pending','failed','no_profile')", args: [] })).rows;
  for (const p of pendingEmails) await sendOfferEmail(p.id);

  const open = (await db.execute({ sql: 'SELECT * FROM first_booking_free_offers WHERE pay_task_id IS NULL', args: [] })).rows;
  if (!open.length) return { tasks: 0 };
  const { bookings, rawClients } = await getCentresAndBookings();
  let tasks = 0;
  for (const o of open) {
    const key = await resolveCentreKey(o, rawClients);
    if (!key) continue;
    const [kind, idStr] = key.split(':');
    const since = new Date(o.offered_at).getTime();
    const first = bookings
      .filter(b => (kind === 'loc' ? String(b.locationId) === idStr : String(b.clientId) === idStr)
        && LIVE_BOOKING_STATUSES.has(b.statusId) && new Date(b.createdDate || b.bookingDate).getTime() >= since)
      .sort((a, b) => new Date(a.createdDate || a.bookingDate) - new Date(b.createdDate || b.bookingDate))[0];
    if (!first) continue;
    const taskId = uuidv4();
    const shiftDate = (first.bookingDate || '').slice(0, 10);
    await db.execute({
      sql: `INSERT INTO tasks (id, department_id, classification_id, title, description, status, priority, assigned_to_emails, due_date, created_by, created_by_name, mentioned_emails, linked_candidates, linked_centres)
            VALUES (?, 'management', '4cb96356-044b-4873-970a-e6963451c620', ?, ?, 'to_do', 'high', ?, NULL, 'system@rawtalent.internal', 'Auto — First booking free', '[]', '[]', ?)`,
      args: [taskId, `First booking free — ${o.centre_name}`,
        `${o.centre_name} was offered "your first booking is free" by ${o.offered_by_name || 'a Workforce Partner'} on ${new Date(o.offered_at).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne' })}.\n\nTheir first booking has come in: RT booking ${first.clientBookingId}, shift on ${shiftDate}.\n\nPlease make sure this booking is not charged to the centre. The educator is still paid as normal.`,
        JSON.stringify([NANCY]), JSON.stringify([{ centreKey: key, name: o.centre_name }])]
    });
    await db.execute({ sql: 'UPDATE first_booking_free_offers SET pay_task_id = ?, booking_id = ?, booking_date = ?, centre_key = COALESCE(centre_key, ?) WHERE id = ?', args: [taskId, String(first.clientBookingId), shiftDate || null, o.lead_id ? null : key, o.id] });
    tasks++;
  }
  return { tasks };
}

module.exports = { cioTrackConfig, resolveContact, sendOfferEmail, processFirstBookings, resolveCentreKey };
