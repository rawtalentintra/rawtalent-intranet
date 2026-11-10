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
async function cioIdentifierFor(o, ct, { allowEmailLookup = true } = {}) {
  if (ct && ct.rtPersonId) return String(ct.rtPersonId);
  if (!allowEmailLookup) return null;
  const appKey = process.env.CUSTOMERIO_APP_API_KEY;
  if (!appKey || !o.contact_email) return null;
  const r = await fetch(`https://api.customer.io/v1/customers?email=${encodeURIComponent(o.contact_email)}`, { headers: { Authorization: `Bearer ${appKey}` } });
  if (!r.ok) throw new Error(`Customer.io lookup ${r.status}`);
  const d = await r.json();
  const hit = (d.results || [])[0];
  return hit && hit.cio_id ? `cio_${hit.cio_id}` : null;
}

// Shared Customer.io signal (profile attributes + one event), used by First
// Booking Free and the dormant touch point (services/dormantService.js).
async function sendCioSignal(ident, attributes, eventName, data) {
  const cfg = cioTrackConfig();
  if (!cfg.ready) throw new Error('Customer.io signals are switched off');
  const auth = 'Basic ' + Buffer.from(`${cfg.siteId}:${cfg.key}`).toString('base64');
  const base = `${cfg.host}/api/v1/customers/${encodeURIComponent(ident)}`;
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };
  const r1 = await fetch(base, { method: 'PUT', headers, body: JSON.stringify(attributes) });
  if (!r1.ok) throw new Error(`Customer.io profile ${r1.status}: ${(await r1.text()).slice(0, 200)}`);
  const r2 = await fetch(`${base}/events`, { method: 'POST', headers, body: JSON.stringify({ name: eventName, data }) });
  if (!r2.ok) throw new Error(`Customer.io event ${r2.status}: ${(await r2.text()).slice(0, 200)}`);
}

// Service type on Customer.io events, in both forms the journeys accept: the text
// HeartBeat stores and RT's serviceTypeId (Yuv, 4 Nov: 0 = ECEC/long day care,
// 1 = OSHC, 2 = Both). Only 1 routes to the OSHC journeys; 0, 2 and blank go ECEC.
const SERVICE_TYPE_IDS = { early_childhood: 0, oshc: 1, both: 2 };
function serviceTypeFields(st) {
  const key = String(st || '').trim().toLowerCase();
  return key in SERVICE_TYPE_IDS ? { service_type: key, service_type_id: SERVICE_TYPE_IDS[key] } : { service_type: '' };
}

// Centre owner by relationship, not state (Liam, 10 Nov 2026). Owner = HeartBeat's
// centre_partner_assignments row, else Liam (same default as My Centres).
const WFP_EMAIL = { Liam: 'liam@rawtalent.com.au', Justine: 'justine@rawtalent.com.au', Gwen: 'gwen@rawtalent.com.au' };
async function ownerFields(centreKey) {
  let name = 'Liam';
  if (centreKey && !String(centreKey).startsWith('lead:')) {
    const r = (await getDb().execute({ sql: 'SELECT workforce_partner FROM centre_partner_assignments WHERE centre_key = ?', args: [centreKey] })).rows[0];
    if (r && r.workforce_partner) name = r.workforce_partner;
  }
  return { wfp_owner_name: name, wfp_owner_email: WFP_EMAIL[name] || '' };
}
// Attributes only (no event): keeps each centre's Customer.io profile's owner current.
async function syncOwnerAttributes(centreKey) {
  const cfg = cioTrackConfig();
  if (!cfg.ready) return 'off';
  const ct = await resolveContact({ centreKey });
  const ident = ct && ct.rtPersonId ? String(ct.rtPersonId) : null; // RT profiles only; no new profiles created
  if (!ident) return 'no_profile';
  const auth = 'Basic ' + Buffer.from(`${cfg.siteId}:${cfg.key}`).toString('base64');
  const r = await fetch(`${cfg.host}/api/v1/customers/${encodeURIComponent(ident)}`, { method: 'PUT', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(await ownerFields(centreKey)) });
  if (!r.ok) throw new Error(`Customer.io profile ${r.status}`);
  return 'sent';
}

// Every RT centre's Customer.io profile gets its owner (attributes only). Daily + after a deploy.
async function syncAllOwnerAttributes() {
  if (!cioTrackConfig().ready) return { skipped: 'off' };
  const { centres } = await getCentresAndBookings();
  const out = { sent: 0, no_profile: 0, failed: 0 };
  for (const c of centres) {
    try { const st = await syncOwnerAttributes(c.centreKey); out[st] = (out[st] || 0) + 1; } catch (_) { out.failed++; }
  }
  return out;
}

async function sendOfferEmail(offerId) {
  const db = getDb();
  const o = (await db.execute({ sql: 'SELECT * FROM first_booking_free_offers WHERE id = ?', args: [offerId] })).rows[0];
  if (!o || ['sent', 'duplicate', 'via_dormant', 'via_lead_journey'].includes(o.email_status)) return o && o.email_status;
  const cfg = cioTrackConfig();
  if (!cfg.ready) return 'pending'; // flag off or credentials missing — retried by the scheduled job
  try {
    const ct = await resolveContact({ leadId: o.lead_id, centreKey: o.centre_key });
    // Emails only go to centres set up in RT (Liam, 19 Oct). A lead tagged FBF
    // waits until it matches an RT centre, then the signal fires.
    if (o.lead_id && !(ct && ct.rtPersonId)) {
      await db.execute({ sql: "UPDATE first_booking_free_offers SET email_status = 'waiting_for_centre' WHERE id = ?", args: [offerId] });
      return 'waiting_for_centre';
    }
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
    const owner = await ownerFields(centreKey);
    const data = { centre_name: o.centre_name, centre_key: centreKey, state: o.state || '', partner_name: o.offered_by_name || '', contact_first_name: o.contact_first_name || '', ...owner };
    const r1 = await fetch(base, { method: 'PUT', headers, body: JSON.stringify({
      first_booking_free: true, first_booking_free_tagged_at: Math.floor(new Date(o.offered_at).getTime() / 1000),
      fbf_centre_name: data.centre_name, fbf_centre_key: centreKey, fbf_state: data.state, fbf_partner_name: data.partner_name, ...owner
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
  // RT down: a lead still resolves to its own contact (no RT centre match), a centre can't.
  let centres = [], rawClients = [];
  try { ({ centres, rawClients } = await getCentresAndBookings()); } catch (err) { if (!leadId) throw err; }
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
    return { centreName: l.centre_name, centreKey: null, email: l.contact_email || null, firstName: l.contact_first_name || null, name: [l.contact_first_name, l.contact_last_name].filter(x => x && !/not provided/i.test(x)).join(' ') || null, state: shortState(l.state), rtPersonId: null };
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
  const pendingEmails = (await db.execute({ sql: "SELECT id FROM first_booking_free_offers WHERE email_status IN ('pending','failed','no_profile','waiting_for_centre')", args: [] })).rows;
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

module.exports = { ownerFields, syncOwnerAttributes, syncAllOwnerAttributes, WFP_EMAIL, cioTrackConfig, sendCioSignal, cioIdentifierFor, resolveContact, sendOfferEmail, processFirstBookings, resolveCentreKey, serviceTypeFields };
