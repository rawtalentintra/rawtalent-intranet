const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const calendarSync = require('../services/leadCalendarSyncService');
const googleCalendarClient = require('../services/googleCalendarClient');

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

// Per-partner Google Calendar OAuth connect flow (CALENDAR_AUTH_MODE=oauth
// — see googleCalendarClient.js). These three routes need to be reachable
// by the PARTNER THEMSELVES under their own HeartBeat session — an admin
// can't complete Google's consent screen on someone else's behalf without
// that person's Google password, which defeats the point of OAuth — so
// they sit ahead of the router.use(requireAdmin) gate below, with their
// own check instead: an admin can trigger/manage any label (useful when
// walking a partner through it in person), a non-admin only their own
// wfp_label.
function canManageCalendarConnection(user, partnerLabel) {
  if (['admin', 'super_admin'].includes(user.role)) return true;
  return !!user.wfp_label && user.wfp_label === partnerLabel;
}

// Starts the consent flow — redirects the partner's own browser to
// Google. `state` carries the partner label through the round trip since
// Google's callback only tells us which Google account authorized, not
// which of our partner labels this is for.
router.get('/connect/:partnerLabel', requireAuth, (req, res) => {
  const partnerLabel = decodeURIComponent(req.params.partnerLabel || '').trim();
  if (!partnerLabel) return res.status(400).send('Missing partner label.');
  if (!canManageCalendarConnection(req.user, partnerLabel)) return res.status(403).send('You can only connect your own calendar.');
  try {
    const consentUrl = googleCalendarClient.buildConsentUrl(partnerLabel);
    // TEMPORARY diagnostic — chasing a generic Google "500. That's an
    // error." on connect after the APP_URL fix. Remove once resolved.
    console.log(`[calendar-oauth] partner=${JSON.stringify(partnerLabel)} APP_URL=${JSON.stringify(process.env.APP_URL)} consentUrl=${consentUrl}`);
    res.redirect(consentUrl);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Google redirects the partner's own browser back here after they
// approve (or decline). No requireAdmin here either — this is Google
// calling back into the SAME browser tab that started the flow, still
// carrying that person's ordinary session cookie (sameSite:lax allows a
// normal top-level redirect like this one through).
router.get('/oauth-callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;
  const partnerLabel = decodeURIComponent(state || '');
  if (error) return res.send(`<p>Google Calendar connection was not completed: ${escapeHtmlLite(error)}. You can close this tab and try again.</p>`);
  if (!code || !partnerLabel) return res.status(400).send('Missing code or state from Google — try connecting again.');
  if (!canManageCalendarConnection(req.user, partnerLabel)) return res.status(403).send('You can only connect your own calendar.');
  try {
    const googleEmail = await googleCalendarClient.saveTokensForPartner(partnerLabel, code, req.user.email);
    res.send(`<p>✅ Connected ${escapeHtmlLite(partnerLabel)}'s calendar (${escapeHtmlLite(googleEmail)}). You can close this tab.</p>`);
  } catch (err) {
    res.status(500).send(`<p>Could not finish connecting: ${escapeHtmlLite(err.message)}</p>`);
  }
});

// Minimal, dependency-free escaping for the plain-text confirmation pages
// above — this route has no HTML template of its own to render into.
function escapeHtmlLite(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

router.delete('/connect/:partnerLabel', requireAuth, async (req, res) => {
  const partnerLabel = decodeURIComponent(req.params.partnerLabel || '').trim();
  if (!canManageCalendarConnection(req.user, partnerLabel)) return res.status(403).json({ error: 'You can only disconnect your own calendar.' });
  try {
    await googleCalendarClient.disconnectPartner(partnerLabel);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-only list of who's currently connected, for the Calendar Sync
// panel's status display.
router.get('/connections', requireAdmin, async (req, res) => {
  try {
    res.json(await googleCalendarClient.listOAuthConnections());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lets the Calendar Sync modal show which auth mode is live and, in
// 'service-account' mode, exactly which address each partner needs to
// share their calendar with — no need to dig that out of Railway/Cloud
// Console by hand.
router.get('/status', requireAdmin, (req, res) => {
  res.json({
    authMode: googleCalendarClient.authMode(),
    serviceAccountEmail: googleCalendarClient.getServiceAccountEmail()
  });
});

// ─── Read-only .ics subscription feed ────────────────────────────────
// Joy, 2026-09-03: after the OAuth Connect flow (a generic Google 500
// with no reachable cause) and 'service-account' mode (blocked by a GCP
// org policy disabling key creation) both hit walls needing access
// nobody could confirm holding, this sidesteps Google's OAuth/API
// surface entirely — see db/schema.sql's calendar_feed_tokens comment.
// Same access rule as /connect above: a non-admin WFP partner can fetch
// their OWN link (canManageCalendarConnection), so these sit ahead of
// the router.use(requireAdmin) gate below, not behind it.
router.get('/feed-link/:partnerLabel', requireAuth, async (req, res) => {
  const partnerLabel = decodeURIComponent(req.params.partnerLabel || '').trim();
  if (!partnerLabel) return res.status(400).json({ error: 'Missing partner label.' });
  if (!canManageCalendarConnection(req.user, partnerLabel)) return res.status(403).json({ error: 'You can only get your own feed link.' });
  try {
    const token = await calendarSync.getOrCreateFeedToken(partnerLabel);
    res.json(feedLinks(token));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Invalidates the old link — for if it ever leaks, or just to force a
// clean re-subscribe.
router.post('/feed-link/:partnerLabel/regenerate', requireAuth, async (req, res) => {
  const partnerLabel = decodeURIComponent(req.params.partnerLabel || '').trim();
  if (!canManageCalendarConnection(req.user, partnerLabel)) return res.status(403).json({ error: 'You can only reset your own feed link.' });
  try {
    const token = await calendarSync.regenerateFeedToken(partnerLabel);
    res.json(feedLinks(token));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function feedLinks(token) {
  const icsUrl = `${(process.env.APP_URL || '').replace(/\/$/, '')}/api/calendar-sync/feed/${token}`;
  // The one-click "Add calendar" trick — opens straight into Google
  // Calendar's own add-by-URL confirmation instead of making someone
  // copy/paste through Settings → Add calendar → From URL by hand.
  return { icsUrl, googleAddUrl: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(icsUrl)}` };
}

// Public, unauthenticated on purpose — Google's calendar-subscription
// fetcher has no HeartBeat session cookie to send; the token itself is
// the credential (see calendarSync.partnerLabelForFeedToken's own
// comment on why the URL carries no separately-trusted partner label).
router.get('/feed/:token', async (req, res) => {
  try {
    const partnerLabel = await calendarSync.partnerLabelForFeedToken(req.params.token);
    if (!partnerLabel) return res.status(404).send('Feed not found.');
    const ics = await calendarSync.buildIcsFeed(partnerLabel);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="${partnerLabel.replace(/[^a-z0-9]+/gi, '-')}.ics"`);
    res.send(ics);
  } catch (err) {
    res.status(500).send('Could not build calendar feed.');
  }
});

router.use(requireAdmin);

// Manual fallback for before push-notification channels are registered
// (e.g. domain-wide delegation not authorized yet) or to force a catch-up.
router.post('/sync-now', async (req, res) => {
  const partners = Object.keys(await calendarSync.getPartnerCalendarMap());
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
  const partners = Object.keys(await calendarSync.getPartnerCalendarMap());
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
