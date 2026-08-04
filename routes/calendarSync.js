const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const calendarSync = require('../services/leadCalendarSyncService');

// Google's push notification callback. No session cookie arrives here —
// Google is the caller — so this route is deliberately outside requireAuth.
// The channel token (set to the partner's email at watch registration time)
// is the only thing identifying which calendar fired; Google does not sign
// or otherwise let us verify these requests, so treat the body as a mere
// trigger to re-poll that one calendar, never as data to trust directly.
router.post('/webhook', async (req, res) => {
  res.status(200).end(); // ack immediately — Google expects a fast 200

  const ownerEmail = req.header('X-Goog-Channel-Token');
  const resourceState = req.header('X-Goog-Resource-State');
  if (!ownerEmail || resourceState === 'sync') return; // initial handshake, nothing to fetch yet

  calendarSync.listAndApplyChanges(ownerEmail).catch(err =>
    console.error(`Calendar webhook sync error (${ownerEmail}):`, err.message));
});

router.use(requireAdmin);

// Manual fallback for before push-notification channels are registered
// (e.g. domain-wide delegation not authorized yet) or to force a catch-up.
router.post('/sync-now', async (req, res) => {
  const partners = Object.keys(calendarSync.getPartnerCalendarMap());
  const results = {};
  for (const email of partners) {
    try {
      await calendarSync.listAndApplyChanges(email);
      results[email] = 'ok';
    } catch (err) {
      results[email] = `error: ${err.message}`;
    }
  }
  res.json({ results });
});

router.post('/watch/register', async (req, res) => {
  const partners = Object.keys(calendarSync.getPartnerCalendarMap());
  const results = {};
  for (const email of partners) {
    try {
      await calendarSync.registerOrRenewWatch(email);
      results[email] = 'ok';
    } catch (err) {
      results[email] = `error: ${err.message}`;
    }
  }
  res.json({ results });
});

router.get('/review-queue', async (req, res) => {
  try {
    const result = await getDb().execute(
      `SELECT * FROM calendar_sync_review_queue WHERE resolved = false ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/review-queue/:id/resolve', async (req, res) => {
  try {
    const { leadId, eventType } = req.body; // leadId omitted = dismiss without linking
    const item = await getDb().execute({ sql: 'SELECT * FROM calendar_sync_review_queue WHERE id = ?', args: [req.params.id] });
    if (!item.rows[0]) return res.status(404).json({ error: 'Review item not found' });

    if (leadId) {
      const resolvedType = eventType || item.rows[0].event_type || 'call';
      const statusColumn = resolvedType === 'visit' ? 'centre_visited_status' : 'lead_called_status';
      // No reliable start time on a manually-resolved item — the admin/partner
      // sets the actual date directly on the lead afterwards; this just links
      // the calendar event so future updates to it sync automatically.
      await getDb().execute({ sql: `UPDATE leads SET ${statusColumn} = 'scheduled', updated_at = now() WHERE id = ?`, args: [leadId] });
    }

    await getDb().execute({ sql: `UPDATE calendar_sync_review_queue SET resolved = true WHERE id = ?`, args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
