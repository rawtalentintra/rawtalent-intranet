const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { isFinalApprover, FINAL_APPROVERS } = require('./leaveService');

const MELBOURNE_TZ = 'Australia/Melbourne';
const WEEK_ANCHOR = '2026-08-16'; // a Sunday — pay period 1 start, weeks run Sun-Sat from here

// Scoped ONLY to AM/PM Team — deliberately not a generic team_members.manager_id
// walk (unlike leaveService.resolveLevel1Approver), since several people
// (Vicky, Gwen, Justine, Sophia, Joy) resolve to a manager via the org chart
// (often Liam) who must NOT get timesheet-approval rights from that
// relationship. Approval here is exactly "Lorie/Adzi for their own team,
// then Sophia/Joy" — nothing more.
const TEAM_APPROVAL_CONFIG = {
  'AM Team': { l1: 'lorie@rawtalent.com.au', l2: 'sophia@rawtalent.com.au' },
  'PM Team': { l1: 'adrianne@rawtalent.com.au', l2: 'joy@rawtalent.com.au' }
};

// pg returns DATE columns as JS Date objects built from the server's local
// timezone — naive serialization shifts the date by the UTC offset. Same
// fix as leaveService.js's toDateOnly, extended to this table's date columns.
function toDateOnly(v) {
  if (!v) return v;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}
function normalizeWeek(row) {
  if (!row) return row;
  return { ...row, week_start_date: toDateOnly(row.week_start_date), week_end_date: toDateOnly(row.week_end_date) };
}
function normalizeWeeks(rows) { return rows.map(normalizeWeek); }
function normalizeEntry(row) {
  if (!row) return row;
  return { ...row, entry_date: toDateOnly(row.entry_date) };
}
function normalizeEntries(rows) { return rows.map(normalizeEntry); }

function pad(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}
function weekStartOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return addDays(dateStr, -d.getDay());
}
function weekEndOf(weekStartStr) { return addDays(weekStartStr, 6); }
function payPeriodStartOf(dateStr) {
  const anchor = new Date(`${WEEK_ANCHOR}T00:00:00`);
  const d = new Date(`${dateStr}T00:00:00`);
  const daysSince = Math.floor((d - anchor) / 86400000);
  const periodIndex = Math.floor(daysSince / 14);
  return addDays(WEEK_ANCHOR, periodIndex * 14);
}
function payPeriodEndOf(ppStartStr) { return addDays(ppStartStr, 13); }

// Simplified 2026-08-26 from a start/end-time pair to a directly-entered
// total, per Joy's ask — just validates the number is sane for a single
// day rather than deriving it from clock-in/out.
function validateHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter the total hours worked');
  if (n > 24) throw new Error('That\'s more hours than a day has — double-check the number');
  return Math.round(n * 100) / 100;
}

async function resolveTeam(db, userEmail) {
  const res = await db.execute({ sql: 'SELECT team FROM team_members WHERE LOWER(email) = LOWER(?) LIMIT 1', args: [userEmail] });
  return res.rows[0]?.team || null;
}

async function recomputeWeekTotal(db, weekId) {
  const res = await db.execute({ sql: 'SELECT COALESCE(SUM(hours), 0) AS total FROM timesheet_entries WHERE week_id = ?', args: [weekId] });
  const total = Number(res.rows[0]?.total || 0);
  await db.execute({ sql: 'UPDATE timesheet_weeks SET total_hours = ?, updated_at = now() WHERE id = ?', args: [total, weekId] });
  return total;
}

async function getOrCreateDraftWeek(db, { id, userEmail, userName, weekStartDate }) {
  const existing = await db.execute({ sql: 'SELECT * FROM timesheet_weeks WHERE user_email = ? AND week_start_date = ?', args: [userEmail, weekStartDate] });
  if (existing.rows[0]) return normalizeWeek(existing.rows[0]);
  await db.execute({
    sql: `INSERT INTO timesheet_weeks (id, user_email, user_name, week_start_date, week_end_date)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (user_email, week_start_date) DO NOTHING`,
    args: [id, userEmail, userName, weekStartDate, weekEndOf(weekStartDate)]
  });
  const res = await db.execute({ sql: 'SELECT * FROM timesheet_weeks WHERE user_email = ? AND week_start_date = ?', args: [userEmail, weekStartDate] });
  return normalizeWeek(res.rows[0]);
}

async function upsertEntry({ id, userEmail, userName, entryDate, hours, notes }) {
  const db = getDb();
  const validHours = validateHours(hours);
  const weekStartDate = weekStartOf(entryDate);
  const week = await getOrCreateDraftWeek(db, { id: uuidv4(), userEmail, userName, weekStartDate });
  if (week.status !== 'draft') throw new Error('This week has already been submitted — recall it before editing');

  await db.execute({
    sql: `INSERT INTO timesheet_entries (id, week_id, user_email, entry_date, hours, notes)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_email, entry_date) DO UPDATE SET
            hours = excluded.hours, notes = excluded.notes, updated_at = now()`,
    args: [id, week.id, userEmail, entryDate, validHours, notes || null]
  });
  await recomputeWeekTotal(db, week.id);
  return getWeek(userEmail, weekStartDate);
}

async function deleteEntry(entryId, userEmail) {
  const db = getDb();
  const res = await db.execute({ sql: 'SELECT * FROM timesheet_entries WHERE id = ? AND user_email = ?', args: [entryId, userEmail] });
  const entry = res.rows[0];
  if (!entry) throw new Error('Entry not found');
  const weekRes = await db.execute({ sql: 'SELECT * FROM timesheet_weeks WHERE id = ?', args: [entry.week_id] });
  const week = weekRes.rows[0];
  if (week && week.status !== 'draft') throw new Error('This week has already been submitted — recall it before editing');
  await db.execute({ sql: 'DELETE FROM timesheet_entries WHERE id = ?', args: [entryId] });
  await recomputeWeekTotal(db, entry.week_id);
  return getWeek(userEmail, toDateOnly(entry.entry_date));
}

async function getWeek(userEmail, weekStartDate) {
  const db = getDb();
  const weekRes = await db.execute({ sql: 'SELECT * FROM timesheet_weeks WHERE user_email = ? AND week_start_date = ?', args: [userEmail, weekStartDate] });
  const week = weekRes.rows[0] ? normalizeWeek(weekRes.rows[0]) : {
    id: null, user_email: userEmail, week_start_date: weekStartDate, week_end_date: weekEndOf(weekStartDate),
    status: 'draft', total_hours: 0, notes: null, rejection_note: null
  };
  const entriesRes = week.id
    ? await db.execute({ sql: 'SELECT * FROM timesheet_entries WHERE week_id = ? ORDER BY entry_date ASC', args: [week.id] })
    : { rows: [] };
  return { week, entries: normalizeEntries(entriesRes.rows) };
}

async function listMyWeeks(userEmail, limit = 12) {
  const res = await getDb().execute({
    sql: 'SELECT * FROM timesheet_weeks WHERE user_email = ? ORDER BY week_start_date DESC LIMIT ?',
    args: [userEmail, limit]
  });
  return normalizeWeeks(res.rows);
}

async function submitWeek(userEmail, userName, weekStartDate) {
  const db = getDb();
  const week = await getOrCreateDraftWeek(db, { id: uuidv4(), userEmail, userName, weekStartDate });
  if (week.status !== 'draft') throw new Error('This week has already been submitted');
  if (Number(week.total_hours) <= 0) throw new Error('Log at least one day before submitting');

  // Final approver's own hours auto-finalize immediately — mirrors
  // leaveService.js's identical self-approval convention.
  if (isFinalApprover(userEmail)) {
    await db.execute({
      sql: `UPDATE timesheet_weeks SET status = 'approved', final_decided_by = ?, final_decided_at = now(),
            submitted_at = now(), rejection_note = NULL, updated_at = now() WHERE id = ?`,
      args: [userEmail, week.id]
    });
    return getWeek(userEmail, weekStartDate);
  }

  const team = await resolveTeam(db, userEmail);
  const config = TEAM_APPROVAL_CONFIG[team];

  if (config && userEmail.toLowerCase() !== config.l1.toLowerCase()) {
    // Regular team member — goes to their team's manager first. The final
    // approver is cached NOW (not re-resolved at the l1-approve step) so a
    // later org-chart edit can never rewrite an in-flight submission.
    await db.execute({
      sql: `UPDATE timesheet_weeks SET status = 'pending_l1', l1_approver_email = ?, l1_approver_name = ?,
            final_approver_email = ?, submitted_at = now(), rejection_note = NULL, updated_at = now() WHERE id = ?`,
      args: [config.l1, teamLeadName(config.l1), config.l2, week.id]
    });
  } else {
    // No team, or this IS the team's own L1 (Lorie/Adzi submitting their own
    // hours) — skip level 1 entirely. If they belong to a configured team,
    // their hours still go specifically to that team's L2 (e.g. Lorie's own
    // hours go to Sophia, not the open pool) — otherwise either of
    // FINAL_APPROVERS is sufficient.
    await db.execute({
      sql: `UPDATE timesheet_weeks SET status = 'pending_final', final_approver_email = ?,
            submitted_at = now(), rejection_note = NULL, updated_at = now() WHERE id = ?`,
      args: [config ? config.l2 : null, week.id]
    });
  }
  return getWeek(userEmail, weekStartDate);
}

function teamLeadName(email) {
  const names = { 'lorie@rawtalent.com.au': 'Lorie Delara', 'adrianne@rawtalent.com.au': 'Adzi Estrella' };
  return names[email.toLowerCase()] || null;
}

async function recall(weekId, userEmail) {
  const db = getDb();
  const res = await db.execute({ sql: 'SELECT * FROM timesheet_weeks WHERE id = ?', args: [weekId] });
  const week = res.rows[0];
  if (!week) throw new Error('Timesheet week not found');
  if (week.user_email.toLowerCase() !== userEmail.toLowerCase()) throw new Error('You can only recall your own timesheet');
  if (!['pending_l1', 'pending_final'].includes(week.status)) throw new Error('This week is not pending approval');
  await db.execute({ sql: "UPDATE timesheet_weeks SET status = 'draft', updated_at = now() WHERE id = ?", args: [weekId] });
  return getWeek(week.user_email, toDateOnly(week.week_start_date));
}

async function decide(weekId, approverEmail, decision, note) {
  const db = getDb();
  const res = await db.execute({ sql: 'SELECT * FROM timesheet_weeks WHERE id = ?', args: [weekId] });
  const week = res.rows[0];
  if (!week) throw new Error('Timesheet week not found');

  if (week.status === 'pending_l1') {
    if (week.l1_approver_email?.toLowerCase() !== approverEmail.toLowerCase()) {
      throw new Error('You are not the approver for this timesheet');
    }
    if (decision === 'reject') {
      await db.execute({
        sql: "UPDATE timesheet_weeks SET status = 'draft', l1_decided_by = ?, l1_decided_at = now(), rejection_note = ?, updated_at = now() WHERE id = ?",
        args: [approverEmail, note, weekId]
      });
    } else {
      await db.execute({
        sql: "UPDATE timesheet_weeks SET status = 'pending_final', l1_decided_by = ?, l1_decided_at = now(), updated_at = now() WHERE id = ?",
        args: [approverEmail, weekId]
      });
    }
  } else if (week.status === 'pending_final') {
    const canDecide = week.final_approver_email
      ? week.final_approver_email.toLowerCase() === approverEmail.toLowerCase()
      : isFinalApprover(approverEmail);
    if (!canDecide) throw new Error('You are not the approver for this timesheet');
    if (decision === 'reject') {
      await db.execute({
        sql: "UPDATE timesheet_weeks SET status = 'draft', final_decided_by = ?, final_decided_at = now(), rejection_note = ?, updated_at = now() WHERE id = ?",
        args: [approverEmail, note, weekId]
      });
    } else {
      await db.execute({
        sql: "UPDATE timesheet_weeks SET status = 'approved', final_decided_by = ?, final_decided_at = now(), updated_at = now() WHERE id = ?",
        args: [approverEmail, weekId]
      });
    }
  } else {
    throw new Error('This timesheet is not awaiting your approval');
  }
  return getWeek(week.user_email, toDateOnly(week.week_start_date));
}

async function listPendingFor(approverEmail) {
  const db = getDb();
  const l1Res = await db.execute({
    sql: "SELECT * FROM timesheet_weeks WHERE status = 'pending_l1' AND LOWER(l1_approver_email) = LOWER(?) ORDER BY week_start_date ASC",
    args: [approverEmail]
  });
  let finalRows = [];
  if (isFinalApprover(approverEmail)) {
    const finalRes = await db.execute({
      sql: "SELECT * FROM timesheet_weeks WHERE status = 'pending_final' AND (LOWER(final_approver_email) = LOWER(?) OR final_approver_email IS NULL) ORDER BY week_start_date ASC",
      args: [approverEmail]
    });
    finalRows = finalRes.rows;
  } else {
    const finalRes = await db.execute({
      sql: "SELECT * FROM timesheet_weeks WHERE status = 'pending_final' AND LOWER(final_approver_email) = LOWER(?) ORDER BY week_start_date ASC",
      args: [approverEmail]
    });
    finalRows = finalRes.rows;
  }
  const weeks = normalizeWeeks([...l1Res.rows, ...finalRows]);
  for (const week of weeks) {
    const entriesRes = await db.execute({ sql: 'SELECT * FROM timesheet_entries WHERE week_id = ? ORDER BY entry_date ASC', args: [week.id] });
    week.entries = normalizeEntries(entriesRes.rows);
    // Lets the frontend group a person's two pay-period weeks into one
    // approval card instead of two — without this it has to reimplement
    // the anchor-week math itself just to tell they're the same period.
    week.pay_period_start = payPeriodStartOf(week.week_start_date);
  }
  return weeks;
}

async function companySummary(fromDate, toDate) {
  const db = getDb();
  const entriesRes = await db.execute({
    sql: `SELECT user_email, user_name, SUM(hours) AS total_hours
          FROM timesheet_entries e JOIN timesheet_weeks w ON w.id = e.week_id
          WHERE e.entry_date >= ? AND e.entry_date <= ?
          GROUP BY user_email, user_name`,
    args: [fromDate, toDate]
  });
  const statusRes = await db.execute({
    sql: `SELECT user_email, status, COUNT(*) AS week_count
          FROM timesheet_weeks
          WHERE week_start_date <= ? AND week_end_date >= ?
          GROUP BY user_email, status`,
    args: [toDate, fromDate]
  });
  const byUser = {};
  for (const row of entriesRes.rows) {
    byUser[row.user_email] = { userEmail: row.user_email, userName: row.user_name, totalHours: Number(row.total_hours), statusCounts: { draft: 0, pending_l1: 0, pending_final: 0, approved: 0 } };
  }
  for (const row of statusRes.rows) {
    if (!byUser[row.user_email]) continue;
    byUser[row.user_email].statusCounts[row.status] = Number(row.week_count);
  }
  return Object.values(byUser).sort((a, b) => (a.userName || '').localeCompare(b.userName || ''));
}

async function companyWeekSummary(weekStartDate) {
  return { weekStart: weekStartDate, weekEnd: weekEndOf(weekStartDate), totals: await companySummary(weekStartDate, weekEndOf(weekStartDate)) };
}

async function companyPayPeriodSummary(payPeriodStart) {
  const w1Start = payPeriodStart;
  const w2Start = addDays(payPeriodStart, 7);
  const [week1, week2, combined] = await Promise.all([
    companySummary(w1Start, weekEndOf(w1Start)),
    companySummary(w2Start, weekEndOf(w2Start)),
    companySummary(payPeriodStart, payPeriodEndOf(payPeriodStart))
  ]);
  return {
    payPeriodStart, payPeriodEnd: payPeriodEndOf(payPeriodStart),
    weeks: [{ weekStart: w1Start, weekEnd: weekEndOf(w1Start), totals: week1 }, { weekStart: w2Start, weekEnd: weekEndOf(w2Start), totals: week2 }],
    combined
  };
}

async function companyMonthSummary(year, month) {
  const from = `${year}-${pad(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${pad(month)}-${pad(lastDay)}`;
  return { from, to, totals: await companySummary(from, to) };
}

async function listAll() {
  const res = await getDb().execute('SELECT * FROM timesheet_weeks ORDER BY created_at DESC');
  return normalizeWeeks(res.rows);
}

async function deleteWeek(id) {
  await getDb().execute({ sql: 'DELETE FROM timesheet_weeks WHERE id = ?', args: [id] });
}

module.exports = {
  MELBOURNE_TZ, WEEK_ANCHOR, TEAM_APPROVAL_CONFIG,
  weekStartOf, weekEndOf, payPeriodStartOf, payPeriodEndOf, validateHours, resolveTeam,
  upsertEntry, deleteEntry, getWeek, listMyWeeks, submitWeek, recall, decide, listPendingFor,
  companyWeekSummary, companyPayPeriodSummary, companyMonthSummary, listAll, deleteWeek
};
