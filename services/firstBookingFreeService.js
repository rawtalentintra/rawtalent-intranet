// First Booking Free (Liam, 15 Oct 2026). See db/schema.sql's
// first_booking_free_offers. Three jobs:
//  1. sendOfferEmail — once-off Customer.io transactional email to the centre
//     contact. Needs CUSTOMERIO_APP_API_KEY and CIO_FIRST_FREE_MESSAGE_ID (the
//     transactional message Joy builds in Customer.io). Until both are set the
//     offer stays 'pending' and is retried automatically.
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

async function sendOfferEmail(offerId) {
  const db = getDb();
  const o = (await db.execute({ sql: 'SELECT * FROM first_booking_free_offers WHERE id = ?', args: [offerId] })).rows[0];
  if (!o || o.email_status === 'sent') return o && o.email_status;
  if (!o.contact_email) {
    await db.execute({ sql: "UPDATE first_booking_free_offers SET email_status = 'no_email' WHERE id = ?", args: [offerId] });
    return 'no_email';
  }
  const key = process.env.CUSTOMERIO_APP_API_KEY, msgId = process.env.CIO_FIRST_FREE_MESSAGE_ID;
  if (!key || !msgId) return 'pending'; // not set up yet — retried by the scheduled job
  try {
    const res = await fetch('https://api.customer.io/v1/send/email', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactional_message_id: msgId,
        to: o.contact_email,
        identifiers: { email: o.contact_email },
        message_data: { centre_name: o.centre_name, contact_first_name: o.contact_first_name || '', partner_name: o.offered_by_name || '', state: o.state || '' }
      })
    });
    if (!res.ok) throw new Error(`Customer.io ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await db.execute({ sql: "UPDATE first_booking_free_offers SET email_status = 'sent', email_sent_at = now(), email_error = NULL WHERE id = ?", args: [offerId] });
    return 'sent';
  } catch (err) {
    await db.execute({ sql: "UPDATE first_booking_free_offers SET email_status = 'failed', email_error = ? WHERE id = ?", args: [String(err.message).slice(0, 300), offerId] });
    return 'failed';
  }
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
  const pendingEmails = (await db.execute({ sql: "SELECT id FROM first_booking_free_offers WHERE email_status IN ('pending','failed')", args: [] })).rows;
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

module.exports = { sendOfferEmail, processFirstBookings, resolveCentreKey };
