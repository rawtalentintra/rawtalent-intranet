// Thin REST wrapper around services/educatorSearchService.js — the exact
// same rt_candidates_cache search/profile lookup routes/mcp.js's
// search_educators/get_educator tools already use, now also reachable as
// plain JSON for the Workforce Partner PWA (Aug 26 meeting). Same access
// gate as routes/centres.js (this data is centre/booking-adjacent).
const express = require('express');
const router = express.Router();
const { requireAuth, requirePwaAccess } = require('../middleware/authMiddleware');
const educatorSearchService = require('../services/educatorSearchService');
const { createTask } = require('./tasks');

router.use(requireAuth, requirePwaAccess);

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const rows = await educatorSearchService.searchEducators(q, Math.min(Number(req.query.limit) || 20, 20));
    res.json(rows.map(r => ({
      userId: r.user_id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unnamed candidate',
      contactNo: r.contact_no,
      email: r.email,
      suburb: r.suburb,
      isActive: r.is_active,
      expiringDocsCount: r.expiring_docs_count
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:userId', async (req, res) => {
  try {
    const row = await educatorSearchService.getEducatorProfile(req.params.userId);
    if (!row) return res.status(404).json({ error: 'Educator not found' });
    const raw = row.raw || {};
    res.json({
      userId: row.user_id,
      name: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unnamed candidate',
      contactNo: row.contact_no,
      email: row.email,
      suburb: row.suburb,
      isActive: row.is_active,
      isDeleted: row.is_deleted,
      expiringDocsCount: row.expiring_docs_count,
      addresses: Array.isArray(raw.addresses) ? raw.addresses : [],
      qualifications: Array.isArray(raw.qualifications) ? raw.qualifications : [],
      // Same sentinel-date filtering as get_educator (routes/mcp.js) — RT's
      // '0001-01-01' (unset) and '9999-12-31' (never expires) aren't real
      // dates to show a person.
      complianceDocuments: (Array.isArray(raw.attachedRequirements) ? raw.attachedRequirements : []).map(r => ({
        name: r.requirementName || 'Document',
        mandatory: !!r.isMandatory,
        expiryDate: (r.expiryDate && !r.expiryDate.startsWith('0001') && !r.expiryDate.startsWith('9999')) ? r.expiryDate : null
      })),
      profileUrl: `https://backoffice.rawtalent.com.au/#/candidateDetails?userID=${row.user_id}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Task-bridge for "request/rebook an educator" — same reasoning as
// routes/centres.js's :centreKey/request-booking (RT has no booking-write
// API for this yet). Kept as its own route (rather than folding into the
// centres one) since this is reached from an educator's own profile
// screen, where the centre may not be the thing already on screen.
router.post('/:userId/request-booking', async (req, res) => {
  const { note, centreKey, centreName } = req.body;
  try {
    const profile = await educatorSearchService.getEducatorProfile(req.params.userId);
    if (!profile) return res.status(404).json({ error: 'Educator not found' });
    const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || `Educator #${req.params.userId}`;
    const title = centreName ? `Book ${name} at ${centreName}` : `Booking request — ${name}`;
    const description = [
      `Requested from the Workforce Partner app by ${req.user.name || req.user.email}.`,
      centreName ? `Centre: ${centreName}` : null,
      note ? `Note: ${note}` : null
    ].filter(Boolean).join('\n');
    const id = await createTask({
      departmentId: 'bookings', title, description,
      linkedCandidates: [{ userId: profile.user_id, name, phone: profile.contact_no || null }],
      createdByEmail: req.user.email, createdByName: req.user.name
    });
    res.json({ success: true, taskId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
