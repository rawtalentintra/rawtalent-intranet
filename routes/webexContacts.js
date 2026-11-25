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

module.exports = router;
