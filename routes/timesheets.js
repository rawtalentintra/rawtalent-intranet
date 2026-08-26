const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
const timesheet = require('../services/timesheetService');
const { isFinalApprover } = require('../services/leaveService');
const { getDb } = require('../db/database');

router.use(requireAuth);

// Same pool-check shape as routes/leaveRequests.js:13-16 — Sophia/Joy are a
// fixed email pool, not a role (Sophia is plain 'admin').
function requireFinalApprover(req, res, next) {
  if (!isFinalApprover(req.user.email)) return res.status(403).json({ error: 'You do not have access to this' });
  next();
}

router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    res.json(await timesheet.listAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/:id', requireSuperAdmin, async (req, res) => {
  try {
    await timesheet.deleteWeek(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/policy', async (req, res) => {
  try {
    const db = getDb();
    const nowRes = await db.execute(`SELECT now() AT TIME ZONE '${timesheet.MELBOURNE_TZ}' AS ts`);
    const melbourneNow = nowRes.rows[0].ts;
    const todayStr = `${melbourneNow.getFullYear()}-${String(melbourneNow.getMonth() + 1).padStart(2, '0')}-${String(melbourneNow.getDate()).padStart(2, '0')}`;
    const currentWeekStart = timesheet.weekStartOf(todayStr);
    const payPeriodStart = timesheet.payPeriodStartOf(todayStr);
    const team = await timesheet.resolveTeam(db, req.user.email);
    const config = timesheet.TEAM_APPROVAL_CONFIG[team];
    const isL1Approver = !!config && config.l1.toLowerCase() === req.user.email.toLowerCase();

    res.json({
      melbourneNow: melbourneNow.toISOString(),
      currentWeekStart,
      currentWeekEnd: timesheet.weekEndOf(currentWeekStart),
      payPeriodStart,
      payPeriodEnd: timesheet.payPeriodEndOf(payPeriodStart),
      thursdayDeadlinePassed: melbourneNow.getDay() > 4 || (melbourneNow.getDay() === 4 && melbourneNow.getHours() >= 8),
      isL1Approver,
      isFinalApprover: isFinalApprover(req.user.email),
      myTeam: team
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/week', async (req, res) => {
  try {
    const weekStart = req.query.weekStart || timesheet.weekStartOf(new Date().toISOString().slice(0, 10));
    res.json(await timesheet.getWeek(req.user.email, weekStart));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/mine', async (req, res) => {
  try {
    res.json(await timesheet.listMyWeeks(req.user.email));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/entries', async (req, res) => {
  try {
    const { id, entryDate, hours, notes } = req.body;
    if (!entryDate || hours == null) return res.status(400).json({ error: 'entryDate and hours are required' });
    const result = await timesheet.upsertEntry({
      id: id || uuidv4(),
      userEmail: req.user.email, userName: req.user.name,
      entryDate, hours, notes
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/entries/:id', async (req, res) => {
  try {
    res.json(await timesheet.deleteEntry(req.params.id, req.user.email));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/weeks/:weekStart/submit', async (req, res) => {
  try {
    res.json(await timesheet.submitWeek(req.user.email, req.user.name, req.params.weekStart));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/weeks/:id/recall', async (req, res) => {
  try {
    res.json(await timesheet.recall(req.params.id, req.user.email));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/pending', async (req, res) => {
  try {
    res.json(await timesheet.listPendingFor(req.user.email));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/weeks/:id/approve', async (req, res) => {
  try {
    res.json(await timesheet.decide(req.params.id, req.user.email, 'approve', req.body.note));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/weeks/:id/reject', async (req, res) => {
  try {
    if (!req.body.note?.trim()) return res.status(400).json({ error: 'A reason is required when rejecting a timesheet' });
    res.json(await timesheet.decide(req.params.id, req.user.email, 'reject', req.body.note));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/company/week', requireFinalApprover, async (req, res) => {
  try {
    const weekStart = req.query.weekStart || timesheet.weekStartOf(new Date().toISOString().slice(0, 10));
    res.json(await timesheet.companyWeekSummary(weekStart));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/company/pay-period', requireFinalApprover, async (req, res) => {
  try {
    const start = req.query.start || timesheet.payPeriodStartOf(new Date().toISOString().slice(0, 10));
    res.json(await timesheet.companyPayPeriodSummary(start));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/company/month', requireFinalApprover, async (req, res) => {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || (now.getMonth() + 1);
    res.json(await timesheet.companyMonthSummary(year, month));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
