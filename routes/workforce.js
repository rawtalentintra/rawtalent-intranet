const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/authMiddleware');
const { isConfigured, getAgentStatuses } = require('../services/webexService');

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

module.exports = router;
