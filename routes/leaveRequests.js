const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
const leave = require('../services/leaveService');

router.use(requireAuth);

// Full history for admin oversight — deliberately above the /:id routes'
// scope, read-only (approve/reject stays with the actual resolved approver).
router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    res.json(await leave.listAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Testing/cleanup only — super_admin can remove any leave request outright,
// separate from the normal approve/reject decision flow.
router.delete('/admin/:id', requireSuperAdmin, async (req, res) => {
  try {
    await leave.deleteRequest(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/policy', (req, res) => {
  res.json({ minNoticeDays: leave.MIN_NOTICE_DAYS, earliestSelectableDate: leave.earliestSelectableDate() });
});

router.get('/my', async (req, res) => {
  try {
    res.json(await leave.listMine(req.user.email));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pending', async (req, res) => {
  try {
    res.json(await leave.listPendingFor(req.user.email));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/calendar', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to dates are required' });
    res.json(await leave.listApprovedInRange(from, to));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { startDate, endDate, reason } = req.body;
    if (!startDate || !endDate) return res.status(400).json({ error: 'Start and end dates are required' });
    if (!reason?.trim()) return res.status(400).json({ error: 'Reason is required' });

    const request = await leave.createRequest({
      id: uuidv4(),
      userEmail: req.user.email,
      userName: req.user.name || req.user.email,
      startDate,
      endDate,
      reason: reason.trim()
    });
    res.json(request);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    res.json(await leave.decide(req.params.id, req.user.email, 'approve', req.body.note));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    res.json(await leave.decide(req.params.id, req.user.email, 'reject', req.body.note));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
