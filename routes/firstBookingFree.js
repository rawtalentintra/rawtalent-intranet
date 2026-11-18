// First Booking Free tag on leads and centres (Liam, 15 Oct 2026). See
// services/firstBookingFreeService.js.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { sendOfferEmail, resolveContact, cioTrackConfig } = require('../services/firstBookingFreeService');

// Admins and partners, plus consultants with Lead Wash access (Call List button, Liam 26 Oct).
router.use((req, res, next) => (req.user && (['admin', 'super_admin', 'workforce_partner'].includes(req.user.role) || require('../services/leadWashService').canWash(req.user)))
  ? next() : res.status(403).json({ error: 'Not allowed' }));

const shape = o => o && ({
  id: o.id, leadId: o.lead_id, centreKey: o.centre_key, centreName: o.centre_name, offeredBy: o.offered_by_name, offeredAt: o.offered_at,
  emailStatus: o.email_status, emailSentAt: o.email_sent_at, bookingId: o.booking_id, bookingDate: o.booking_date, payTaskCreated: !!o.pay_task_id
});

router.get('/', async (req, res) => {
  try {
    const { leadId, centreKey } = req.query;
    if (!leadId && !centreKey) {
      const rows = (await getDb().execute({ sql: 'SELECT * FROM first_booking_free_offers ORDER BY offered_at DESC', args: [] })).rows;
      return res.json(rows.map(shape));
    }
    const row = (await getDb().execute({ sql: `SELECT * FROM first_booking_free_offers WHERE ${leadId ? 'lead_id' : 'centre_key'} = ?`, args: [leadId || centreKey] })).rows[0];
    res.json(shape(row) || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// First booking free only for centres that are new with no bookings yet, or
// dormant (no booking for 6+ months) (Liam, 16 Nov 2026, Fathom 900546391).
// Cancelled/unfilled bookings don't count; HeartBeat holds ~12 months of RT
// bookings, so a centre with none in that window counts as dormant.
async function centreEligibility(centreKey) {
  try {
    const centresMod = require('./centres');
    const { centres, bookings } = await centresMod.getCentresAndBookings();
    const c = centres.find(x => x.centreKey === centreKey);
    if (!c) return { eligible: true };
    const list = centresMod.bookingsForCentre(centresMod.indexBookingsByCentre(bookings), c);
    const live = list.filter(b => !b.isDeleted && ![6, 7].includes(b.statusId));
    if (!live.length) return { eligible: true, reason: 'no_bookings' };
    const { lastMeaningfulBookingDate } = require('../services/centreHealthService');
    const last = lastMeaningfulBookingDate(list, { rtLocationId: c.rtLocationId, rtClientId: c.rtClientId });
    const days = last ? (Date.now() - last.getTime()) / 86400000 : null;
    if (last && days >= require('../services/dormantService').DORMANT_DAYS) return { eligible: true, reason: 'dormant', lastBookingDate: last.toISOString().slice(0, 10) };
    return { eligible: false, reason: last ? 'active' : 'upcoming_booking', lastBookingDate: last ? last.toISOString().slice(0, 10) : null };
  } catch (_) { return { eligible: true }; } // RT down: don't hide the button
}

// Lead: "No free first booking" straight from the lead page (Joy, 18 Nov), same choice
// the Log call/visit form asks for. 'clear' undoes a No while the welcome email hasn't gone.
router.post('/lead-choice', async (req, res) => {
  try {
    const { leadId, choice } = req.body || {};
    if (!leadId || !['no', 'clear'].includes(choice)) return res.status(400).json({ error: 'leadId and choice (no|clear) are required' });
    const db = getDb();
    const l = (await db.execute({ sql: 'SELECT fbf_choice, lead_journey_status FROM leads WHERE id = ?', args: [leadId] })).rows[0];
    if (!l) return res.status(404).json({ error: 'Lead not found' });
    if (choice === 'no') {
      if (l.fbf_choice === 'yes') return res.status(409).json({ error: 'This lead is already tagged first booking free. Remove that first.' });
      await db.execute({ sql: "UPDATE leads SET fbf_choice = 'no', fbf_choice_by = ?, fbf_choice_at = now() WHERE id = ? AND fbf_choice IS NULL", args: [req.user.name || req.user.email, leadId] });
    } else {
      if (l.lead_journey_status === 'sent') return res.status(409).json({ error: 'Their welcome email has already gone out, so this can no longer be changed.' });
      await db.execute({ sql: "UPDATE leads SET fbf_choice = NULL, fbf_choice_by = NULL, fbf_choice_at = NULL WHERE id = ? AND fbf_choice = 'no'", args: [leadId] });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Preview who Customer.io would email, shown before and after tagging.
router.get('/contact', async (req, res) => {
  try {
    const { leadId, centreKey } = req.query;
    const ct = await resolveContact({ leadId, centreKey });
    if (!ct) return res.status(404).json({ error: 'Not found' });
    let leadChoice = {};
    if (leadId) {
      const l = (await getDb().execute({ sql: 'SELECT fbf_choice, fbf_choice_by, lead_journey_status FROM leads WHERE id = ?', args: [leadId] })).rows[0];
      if (l) leadChoice = { fbfChoice: l.fbf_choice || null, fbfChoiceBy: l.fbf_choice_by || null, journeySent: l.lead_journey_status === 'sent' };
    }
    res.json({ name: ct.name, centreName: ct.centreName || null, email: ct.email, inRt: !!ct.rtPersonId, live: cioTrackConfig().ready, ...leadChoice, ...(centreKey ? await centreEligibility(centreKey) : { eligible: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { leadId, centreKey } = req.body || {};
    if (!leadId && !centreKey) return res.status(400).json({ error: 'leadId or centreKey is required' });
    const db = getDb();
    const ct = await resolveContact({ leadId, centreKey });
    if (!ct) return res.status(404).json({ error: leadId ? 'Lead not found' : 'Centre not found' });
    const { centreName, email: contactEmail, firstName: contactFirst, state } = ct;
    const existing = (await db.execute({ sql: `SELECT * FROM first_booking_free_offers WHERE ${leadId ? 'lead_id' : 'centre_key'} = ?`, args: [leadId || centreKey] })).rows[0];
    if (existing) return res.json(shape(existing));
    if (!leadId) {
      const el = await centreEligibility(centreKey);
      if (!el.eligible) return res.status(409).json({ error: 'First booking free is only for new centres with no bookings yet, or dormant centres (no booking in 6 months).' });
    }
    if (leadId) {
      const l = (await db.execute({ sql: 'SELECT fbf_choice FROM leads WHERE id = ?', args: [leadId] })).rows[0];
      if (l && l.fbf_choice === 'no') return res.status(409).json({ error: 'This lead was logged as "No free first booking".' });
    }
    // A lead's offer is carried by Journey 1 Leads' first email (E0a has the FBF
    // box, services/leadJourneyService.js), so no separate offer email for leads.
    const row = (await db.execute({
      sql: `INSERT INTO first_booking_free_offers (lead_id, centre_key, centre_name, contact_email, contact_first_name, offered_by_email, offered_by_name, state, email_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      args: [leadId || null, leadId ? null : centreKey, centreName, contactEmail, contactFirst, req.user.email, req.user.name || req.user.email, state, leadId ? 'via_lead_journey' : 'pending']
    })).rows[0];
    if (leadId) await db.execute({ sql: "UPDATE leads SET fbf_choice = 'yes', fbf_choice_by = ?, fbf_choice_at = now() WHERE id = ? AND fbf_choice IS NULL", args: [req.user.name || req.user.email, leadId] });
    else await sendOfferEmail(row.id).catch(() => {});
    const fresh = (await db.execute({ sql: 'SELECT * FROM first_booking_free_offers WHERE id = ?', args: [row.id] })).rows[0];
    res.status(201).json(shape(fresh));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Undo a tag made by mistake — only before the email has gone and before a booking came in.
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const o = (await db.execute({ sql: 'SELECT * FROM first_booking_free_offers WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (o.email_status === 'sent' || o.pay_task_id) return res.status(409).json({ error: 'The offer email or booking has already gone out, so this can no longer be removed.' });
    if (o.lead_id) {
      const l = (await db.execute({ sql: 'SELECT lead_journey_status FROM leads WHERE id = ?', args: [o.lead_id] })).rows[0];
      if (l && l.lead_journey_status === 'sent') return res.status(409).json({ error: 'The welcome email with the offer has already gone out, so this can no longer be removed.' });
    }
    await db.execute({ sql: 'DELETE FROM first_booking_free_offers WHERE id = ?', args: [o.id] });
    // Undoing a lead's tag clears its yes so the next log asks again — unless the journey already started with it.
    if (o.lead_id) await db.execute({ sql: "UPDATE leads SET fbf_choice = NULL, fbf_choice_by = NULL, fbf_choice_at = NULL WHERE id = ? AND fbf_choice = 'yes' AND lead_journey_status IS DISTINCT FROM 'sent'", args: [o.lead_id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
