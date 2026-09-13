const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/authMiddleware');
const vicWwccExportService = require('../services/vicWwccExportService');

// Same sensitivity tier as Document Checker / VEVO Check (real candidate
// compliance data) — admin/super_admin only.
router.use(requireAdmin);

// The report itself — every bucket (ready/blank/malformed/multipleRecords/
// duplicateNumbers) shown on screen before anyone downloads anything, so
// what's about to be exported (and what's being deliberately left out, and
// why) is visible up front rather than hidden inside a CSV.
router.get('/report', async (req, res) => {
  try {
    res.json(await vicWwccExportService.buildVicWwccExportReport());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The actual file to upload to Service Victoria's own bulk-check tool
// (step 7 of the SOP, still done by hand — see vicWwccExportService.js's
// own header for why). Only ever the clean "ready" rows — nothing blank,
// malformed, ambiguous, or duplicated ever reaches this file.
router.get('/csv', async (req, res) => {
  try {
    const report = await vicWwccExportService.buildVicWwccExportReport();
    const csv = vicWwccExportService.toCsv(report.ready);
    const filename = `${new Date().toISOString().slice(0, 10)} VIC WWCC Bulk Check.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
