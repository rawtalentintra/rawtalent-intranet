const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/authMiddleware');
const rtApi = require('../services/rtApiReportService');

// Admin/super_admin only for now — access for other roles (e.g. Workforce
// Partners) can be revisited later once this is settled in, per how it
// was scoped when this was built.
router.use(requireAdmin);

const REPORT_TYPES = ['clients', 'candidates', 'bookings', 'timesheets'];

function parseFilters(req) {
  const { startDate, endDate, isActive } = req.query;
  return {
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    isActive: isActive === undefined || isActive === '' ? undefined : isActive === 'true'
  };
}

REPORT_TYPES.forEach(type => {
  // Full dataset for the given filters — the dashboard computes all its
  // own KPIs/breakdowns client-side from this, same pattern as Leads/Sales.
  router.get(`/${type}`, async (req, res) => {
    try {
      const items = await rtApi.fetchAllPages(type, parseFilters(req));
      res.json(items);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get(`/${type}/:id`, async (req, res) => {
    try {
      const item = await rtApi.fetchById(type, req.params.id);
      res.json(item);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
});

module.exports = router;
