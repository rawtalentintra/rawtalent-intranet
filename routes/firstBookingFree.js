// First Booking Free tag on leads and centres (Liam, 15 Oct 2026). See
// services/firstBookingFreeService.js.
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const { sendOfferEmail } = require('../services/firstBookingFreeService');
const { getCentresAndBookings } = require('./centres');

router.use(requireRole('admin', 'super_admin', 'workforce_partner'));

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

router.post('/', async (req, res) => {
  try {
    const { leadId, centreKey } = req.body || {};
    if (!leadId && !centreKey) return res.status(400).json({ error: 'leadId or centreKey is required' });
    const db = getDb();
    let centreName, contactEmail = null, contactFirst = null;
    if (leadId) {
      const l = (await db.execute({ sql: 'SELECT centre_name, contact_email, contact_first_name FROM leads WHERE id = ?', args: [leadId] })).rows[0];
      if (!l) return res.status(404).json({ error: 'Lead not found' });
      centreName = l.centre_name; contactEmail = l.contact_email || null; contactFirst = l.contact_first_name || null;
    } else {
      const { centres } = await getCentresAndBookings();
      const c = centres.find(x => x.centreKey === centreKey);
      if (!c) return res.status(404).json({ error: 'Centre not found' });
      centreName = c.name; contactEmail = c.email || null; contactFirst = (c.contactName || '').split(' ')[0] || null;
    }
    const existing = (await db.execute({ sql: `SELECT * FROM first_booking_free_offers WHERE ${leadId ? 'lead_id' : 'centre_key'} = ?`, args: [leadId || centreKey] })).rows[0];
    if (existing) return res.json(shape(existing));
    const row = (await db.execute({
      sql: `INSERT INTO first_booking_free_offers (lead_id, centre_key, centre_name, contact_email, contact_first_name, offered_by_email, offered_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      args: [leadId || null, leadId ? null : centreKey, centreName, contactEmail, contactFirst, req.user.email, req.user.name || req.user.email]
    })).rows[0];
    await sendOfferEmail(row.id).catch(() => {});
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
    await db.execute({ sql: 'DELETE FROM first_booking_free_offers WHERE id = ?', args: [o.id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
