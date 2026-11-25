// Webex caller ID sync, Joy only (super_admin). See services/webexContactsService.js.
const express = require('express');
const router = express.Router();
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const svc = require('../services/webexContactsService');

router.get('/status', requireSuperAdmin, async (req, res) => {
  try { res.json(await svc.status()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ?dry=1 shows what would change without touching Webex.
router.post('/sync', requireSuperAdmin, async (req, res) => {
  try { res.json(await svc.sync({ dryRun: req.query.dry === '1' })); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/sync', requireSuperAdmin, async (req, res) => {
  try { res.json(await svc.sync({ dryRun: req.query.dry !== '0' })); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Paste a new RawTalent-WF refresh token (from developer.webex.com → RawTalent-WF →
// Org Authorizations) after the app's scopes change. Joy only; the token is never shown back.
router.get('/token', requireSuperAdmin, (req, res) => {
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Webex token</title>
  <body style="font-family:system-ui;background:#f5f7fb;padding:24px;max-width:640px;margin:auto">
  <h2>Update HeartBeat's Webex token</h2>
  <ol><li>developer.webex.com → My Webex Apps → <b>RawTalent-WF</b></li>
  <li>Org Authorizations → pick <b>Raw Talent Recruitment</b> → copy the <b>Refresh token</b></li>
  <li>Paste it below and save.</li></ol>
  <form method="post"><textarea name="refresh" rows="4" style="width:100%" required></textarea>
  <p><button style="padding:8px 16px">Save token</button></p></form></body>`);
});
router.post('/token', requireSuperAdmin, express.urlencoded({ extended: false }), async (req, res) => {
  const refresh = String(req.body.refresh || '').trim();
  if (refresh.length < 40) return res.status(400).send('That does not look like a refresh token.');
  try {
    const { getDb } = require('../db/database');
    await getDb().execute({ sql: `UPDATE webex_auth_state SET refresh_token = ?, access_token = NULL, access_token_expires_at = 0, updated_at = now() WHERE id = 1`, args: [refresh] });
    const st = await svc.status();
    res.send(`<p style="font-family:system-ui;padding:24px">Saved. Webex connection: ${st.connected ? 'working' : 'NOT working, check the token'}. <a href="/auth/webex-contacts/sync">Run a dry run</a></p>`);
  } catch (e) { res.status(500).send('Failed: ' + e.message); }
});

module.exports = router;
