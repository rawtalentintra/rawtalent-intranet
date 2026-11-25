// Webex caller ID sync, Joy only (super_admin). See services/webexContactsService.js.
const express = require('express');
const router = express.Router();
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const svc = require('../services/webexContactsService');

// Step 1: send Joy to Webex to approve contact access (one time).
router.get('/', requireSuperAdmin, (req, res) => {
  if (!svc.isConfigured()) return res.status(500).send('WEBEX_CLIENT_ID / WEBEX_CLIENT_SECRET are missing.');
  const state = svc.newState();
  req.session.webexContactsState = state;
  res.redirect(svc.buildAuthorizeUrl(state));
});

router.get('/callback', requireSuperAdmin, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Webex did not grant access (${error}).`);
  if (!code || !state || state !== req.session.webexContactsState) return res.status(400).send('This link expired. Open /auth/webex-contacts again.');
  delete req.session.webexContactsState;
  try {
    await svc.exchangeCode(code, req.user.email);
    // Kick off the first sync straight away.
    svc.sync().then(r => console.log('Webex contacts sync:', JSON.stringify(r))).catch(e => console.error('Webex contacts sync:', e.message));
    res.redirect('/auth/webex-contacts/status');
  } catch (e) { res.status(500).send('Failed to connect: ' + e.message); }
});

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

module.exports = router;
