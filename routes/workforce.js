const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/authMiddleware');
const { isConfigured, getAgentStatuses } = require('../services/webexService');

// qa_view added alongside admin/super_admin so the Workforce Queue nav
// item (public/admin.html RESTRICTED_ROLE_SECTIONS) actually works for
// that role instead of nav-visible-but-403.
router.use(requireRole('admin', 'super_admin', 'qa_view'));

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
