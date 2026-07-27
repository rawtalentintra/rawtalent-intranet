const express = require('express');
const router = express.Router();
const { requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
const { isConfigured, getAgentStatuses, syncCallHistory, getCdrSyncStatus, getWorkforceStats } = require('../services/webexService');

router.use(requireAdmin);

router.get('/agent-status', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.json({ configured: false, agents: [] });
    }
    const result = await getAgentStatuses();
    res.json(result);
  } catch (err) {
    console.error('Webex agent status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Workforce Management Dashboard (call history stats) — super_admin only
// for now, since it's built on raw Detailed Call History data.
router.get('/call-history/status', requireSuperAdmin, async (req, res) => {
  try {
    res.json(await getCdrSyncStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/call-history/sync', requireSuperAdmin, async (req, res) => {
  try {
    const result = await syncCallHistory(req.user.email);
    res.json(result);
  } catch (err) {
    console.error('Webex call history sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/call-history/stats', requireSuperAdmin, async (req, res) => {
  try {
    const rangeDays = req.query.range === 'day' ? 1 : req.query.range === 'week' ? 7 : Number(req.query.days) || 7;
    res.json(await getWorkforceStats(rangeDays));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
