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

// Adjacent WEEK's start date, server-derived — same reasoning as
// /pay-period-nav above, one level down: Log My Hours' own Prev/Next
// (views/index.html's changeHoursWeek) used to do a blind ±7-day shift,
// which is correct everywhere except right at the 2026-09-26 Sat-start
// transition (see timesheetService.js's SAT_TRANSITION_DATE) — a plain
// +7 from the outgoing Sun20-Sat26 week lands back on 2026-09-27, the
// old scheme's stale boundary, instead of 2026-09-26. No requireFinalApprover
// here — every employee steps through their own weeks on this page, not
// just Sophia/Joy.
router.get('/week-nav', async (req, res) => {
  try {
    const { from, direction } = req.query;
    if (!from || !['next', 'prev'].includes(direction)) return res.status(400).json({ error: 'from and direction (next|prev) are required' });
    const adjacentDate = direction === 'next' ? timesheet.addDays(timesheet.weekEndOf(from), 1) : timesheet.addDays(from, -1);
    res.json({ weekStart: timesheet.weekStartOf(adjacentDate) });
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

// Read-only "who approved what" list — a separate 4-person pool
// (Sophia/Joy/Lorie/Adrianne) from requireFinalApprover above; row-scoping
// (Sophia/Joy see all, Lorie/Adrianne see only their own approvals) lives
// in timesheetService.listApprovedTimesheets, the single source of truth
// for both the pool and the filtering.
router.get('/approved', async (req, res) => {
  try {
    res.json(await timesheet.listApprovedTimesheets(req.user.email));
  } catch (err) {
    res.status(403).json({ error: err.message });
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

// So the Payroll admin table's hours-correction modal can show what's
// really logged for each day of someone else's week before picking one
// to correct — GET /week (below) is self-only (no userEmail param),
// which is right for the normal Log My Hours screen but not usable here.
router.get('/admin/week', requireFinalApprover, async (req, res) => {
  try {
    const { userEmail, weekStartDate } = req.query;
    if (!userEmail || !weekStartDate) return res.status(400).json({ error: 'userEmail and weekStartDate are required' });
    res.json(await timesheet.getWeek(userEmail, weekStartDate));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct payroll-level hours correction from the admin Payslips table —
// only Sophia/Joy, works on any status (draft/pending/approved) without
// forcing a week back through the approval chain. See
// timesheetService.adminAdjustDayHours for why this corrects one real
// day's entry (and recomputes the week total from it) rather than
// overriding the week total in isolation.
router.post('/admin/weeks/adjust-day', requireFinalApprover, async (req, res) => {
  try {
    const { userEmail, userName, weekStartDate, entryDate, hours } = req.body;
    if (!userEmail || !weekStartDate || !entryDate) return res.status(400).json({ error: 'userEmail, weekStartDate and entryDate are required' });
    res.json(await timesheet.adminAdjustDayHours(userEmail, userName, weekStartDate, req.user.email, entryDate, hours));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Adjacent pay period's start date, computed server-side rather than a
// blind ±14-day shift in the frontend (views/admin.html's
// changePayrollPeriod) — the two agree everywhere except right at the
// 2026-09-26 Sat-start transition (see timesheetService.js's
// SAT_TRANSITION_DATE), where the period immediately before it is only
// 13 days long, not 14 — a client-side +14 would land Next on the old
// scheme's stale boundary (2026-09-27) instead of the new one
// (2026-09-26). Re-deriving from payPeriodEndOf/payPeriodStartOf (the
// same functions everything else uses) makes this correct automatically,
// including at that one irregular seam, with nothing special-cased here.
router.get('/pay-period-nav', requireFinalApprover, async (req, res) => {
  try {
    const { from, direction } = req.query;
    if (!from || !['next', 'prev'].includes(direction)) return res.status(400).json({ error: 'from and direction (next|prev) are required' });
    const adjacentDate = direction === 'next' ? timesheet.addDays(timesheet.payPeriodEndOf(from), 1) : timesheet.addDays(from, -1);
    res.json({ payPeriodStart: timesheet.payPeriodStartOf(adjacentDate) });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
