// Journey 1 Leads trigger (Liam, Management Meeting 28 Oct 2026). See
// db/schema.sql's leads.fbf_choice / lead_journey_* columns.
//  - A call or visit can't be logged on a lead until "First booking free" or
//    "No free first booking" is picked (asked once per lead).
//  - The first call/visit a Workforce Partner (users.wfp_label: Gwen, Justine,
//    Liam) logs sends Customer.io lead_first_contact_logged, which starts
//    Journey 1 Leads (#42 ECEC, #43 OSHC): E0a (FBF) or E0b, then E2–E7.
//    Consultants' calls never trigger it.
//  - Behind the same FBF_CIO_ENABLED flag as First Booking Free. A lead with no
//    contact email waits ('no_email') and is retried for RETRY_DAYS, so adding
//    the email soon after still starts the journey; after that it's 'expired'
//    (a "lovely to meet you" email weeks later would read wrong).
// Reads RT only; never writes to RT.
const { getDb } = require('../db/database');
const fbf = require('./firstBookingFreeService');

const RETRY_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Profile to send to: the RT client (person id) when the lead matches an RT
// centre, else an existing Customer.io profile with that email, else the
// email itself. The workspace identifies by id OR email, so an email-only
// profile is created for a brand-new lead, and RT Portal's later identify
// (id + same email) lands on that same profile.
async function identifierFor(lead, ct) {
  const email = (ct && ct.email) || lead.contact_email;
  const ident = await fbf.cioIdentifierFor({ contact_email: email }, ct);
  if (ident) return { ident, email, emailProfile: false };
  return email && EMAIL_RE.test(email) ? { ident: email.trim().toLowerCase(), email, emailProfile: true } : { ident: null, email };
}

async function sendFirstContactSignal(leadId) {
  const db = getDb();
  const l = (await db.execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [leadId] })).rows[0];
  if (!l || !l.lead_journey_status || ['sent', 'expired'].includes(l.lead_journey_status)) return l && l.lead_journey_status;
  if (!fbf.cioTrackConfig().ready) return 'pending';
  try {
    const ct = await fbf.resolveContact({ leadId });
    const { ident, email } = await identifierFor(l, ct);
    if (!ident) {
      await db.execute({ sql: "UPDATE leads SET lead_journey_status = ? WHERE id = ?", args: [email ? 'no_profile' : 'no_email', leadId] });
      return email ? 'no_profile' : 'no_email';
    }
    const firstName = (ct && ct.firstName) || (l.contact_first_name && !/not provided/i.test(l.contact_first_name) ? l.contact_first_name : '');
    const data = {
      first_booking_free: l.fbf_choice === 'yes',
      service_type: l.service_type || '',
      first_name: firstName || '',
      centre_name: (ct && ct.centreName) || l.centre_name || '',
      state: (ct && ct.state) || String(l.state || '').toUpperCase(),
      email: email || '',
      wfp_name: l.lead_journey_by || '',
      lead_id: l.id
    };
    // A brand-new email-only profile gets its email and first name; an existing
    // client's profile is left as RT set it.
    const attrs = ident === (email || '').trim().toLowerCase() && !(ct && ct.rtPersonId)
      ? { email: data.email, ...(data.first_name ? { first_name: data.first_name } : {}) } : {};
    // RT Footer's "first booking is on us" reminder (Liam, 4 Nov) shows on
    // customer.first_booking_free, so a FBF lead carries it on the profile too.
    if (data.first_booking_free) attrs.first_booking_free = true;
    await fbf.sendCioSignal(ident, attrs, 'lead_first_contact_logged', data);
    await db.execute({ sql: "UPDATE leads SET lead_journey_status = 'sent', lead_journey_sent_at = now(), lead_journey_identifier = ?, lead_journey_error = NULL WHERE id = ?", args: [ident, leadId] });
    return 'sent';
  } catch (err) {
    await db.execute({ sql: "UPDATE leads SET lead_journey_status = 'failed', lead_journey_error = ? WHERE id = ?", args: [String(err.message).slice(0, 300), leadId] });
    return 'failed';
  }
}

// Called by POST /api/leads/:id/activities after the activity is saved.
// `choice` is the FBF yes/no picked on this log (only used if the lead has none).
async function onActivityLogged(lead, user, choice) {
  const db = getDb();
  if (!lead.fbf_choice && (choice === 'yes' || choice === 'no')) {
    await db.execute({ sql: 'UPDATE leads SET fbf_choice = ?, fbf_choice_by = ?, fbf_choice_at = now() WHERE id = ? AND fbf_choice IS NULL', args: [choice, user.name || user.email, lead.id] });
    if (choice === 'yes') {
      // Record the offer for accounts (no-charge task on the first booking). The
      // FBF box is inside E0a, so no separate first_booking_free_tagged email.
      const existing = (await db.execute({ sql: 'SELECT id FROM first_booking_free_offers WHERE lead_id = ?', args: [lead.id] })).rows[0];
      if (!existing) {
        await db.execute({
          sql: `INSERT INTO first_booking_free_offers (lead_id, centre_name, contact_email, contact_first_name, offered_by_email, offered_by_name, state, email_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'via_lead_journey')`,
          args: [lead.id, lead.centre_name, lead.contact_email || null, lead.contact_first_name || null, user.email, user.name || user.email, String(lead.state || '').toUpperCase() || null]
        });
      }
    }
  }
  if (user.wfp_label && !lead.lead_journey_status) {
    const r = await db.execute({ sql: "UPDATE leads SET lead_journey_status = 'pending', lead_journey_at = now(), lead_journey_by = ? WHERE id = ? AND lead_journey_status IS NULL", args: [user.wfp_label, lead.id] });
    if (r.rowsAffected !== 0) await sendFirstContactSignal(lead.id).catch(() => {});
  }
}

// Retried by the same scheduled job as First Booking Free (server.js).
async function retryPending() {
  const db = getDb();
  await db.execute({ sql: `UPDATE leads SET lead_journey_status = 'expired' WHERE lead_journey_status IN ('pending','failed','no_email','no_profile') AND lead_journey_at < now() - (? || ' days')::interval`, args: [String(RETRY_DAYS)] });
  if (!fbf.cioTrackConfig().ready) return 0;
  const rows = (await db.execute({ sql: "SELECT id FROM leads WHERE lead_journey_status IN ('pending','failed','no_email','no_profile')", args: [] })).rows;
  for (const r of rows) await sendFirstContactSignal(r.id);
  return rows.length;
}

module.exports = { onActivityLogged, sendFirstContactSignal, retryPending, RETRY_DAYS };
