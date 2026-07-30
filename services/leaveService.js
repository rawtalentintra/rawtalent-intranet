const { getDb } = require('../db/database');

// Final-approval pool — fixed, not derived from the org chart. Either one
// approving is sufficient; both are notified.
const FINAL_APPROVERS = ['sophia@rawtalent.com.au', 'joy@rawtalent.com.au'];

const MIN_NOTICE_DAYS = 14;

function isFinalApprover(email) {
  return !!email && FINAL_APPROVERS.includes(email.toLowerCase());
}

// pg returns DATE columns as JS Date objects constructed from the local
// server timezone — serializing them naively (toISOString, template
// strings) shifts the date by the server's UTC offset (e.g. midnight AEST
// becomes 14:00 the PREVIOUS day in UTC), silently corrupting the date a
// caller sees. Reading the local getters recovers the original calendar
// date regardless of server timezone. Every row leaving this module goes
// through this before the route layer JSON-serializes it.
function toDateOnly(v) {
  if (!v) return v;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}
function normalizeRow(row) {
  if (!row) return row;
  return { ...row, start_date: toDateOnly(row.start_date), end_date: toDateOnly(row.end_date) };
}
function normalizeRows(rows) {
  return rows.map(normalizeRow);
}

function earliestSelectableDate() {
  const d = new Date();
  d.setDate(d.getDate() + MIN_NOTICE_DAYS);
  return d.toISOString().slice(0, 10);
}

// Walks team_members (name/position/manager_id org chart) to find the
// requester's direct manager, then resolves that manager to a users.email —
// not every team_members row has a login (e.g. the Founder), so this can
// come back null, in which case the caller falls straight through to final
// approval instead of blocking on a manager who can't log in to approve.
async function resolveLevel1Approver(db, userEmail) {
  const meRes = await db.execute({ sql: 'SELECT manager_id FROM team_members WHERE LOWER(email) = LOWER(?) LIMIT 1', args: [userEmail] });
  const managerId = meRes.rows[0]?.manager_id;
  if (!managerId) return null;

  const mgrRes = await db.execute({ sql: 'SELECT name, email FROM team_members WHERE id = ? LIMIT 1', args: [managerId] });
  const manager = mgrRes.rows[0];
  if (!manager?.email) return null;

  // A manager who is themselves one of the final approvers (e.g. Lorie/Adzi
  // reporting to Sophia/Joy) doesn't need a distinct level-1 step.
  if (isFinalApprover(manager.email)) return null;

  const loginRes = await db.execute({ sql: 'SELECT email FROM users WHERE LOWER(email) = LOWER(?) AND active = true LIMIT 1', args: [manager.email] });
  if (!loginRes.rows[0]) return null;

  return { email: manager.email, name: manager.name };
}

async function createRequest({ id, userEmail, userName, startDate, endDate, reason }) {
  const db = getDb();
  if (new Date(startDate) < new Date(earliestSelectableDate())) {
    throw new Error(`Leave requests need at least ${MIN_NOTICE_DAYS} days' notice`);
  }
  if (new Date(endDate) < new Date(startDate)) {
    throw new Error('End date must be on or after the start date');
  }

  const level1 = await resolveLevel1Approver(db, userEmail);
  const status = level1 ? 'pending_manager' : 'pending_final';

  await db.execute({
    sql: `INSERT INTO leave_requests (id, user_email, user_name, start_date, end_date, reason, status, level1_approver_email, level1_approver_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, userEmail, userName, startDate, endDate, reason, status, level1?.email || null, level1?.name || null]
  });

  return getRequest(id);
}

async function getRequest(id) {
  const res = await getDb().execute({ sql: 'SELECT * FROM leave_requests WHERE id = ?', args: [id] });
  return normalizeRow(res.rows[0]) || null;
}

async function listMine(userEmail) {
  const res = await getDb().execute({
    sql: 'SELECT * FROM leave_requests WHERE LOWER(user_email) = LOWER(?) ORDER BY created_at DESC',
    args: [userEmail]
  });
  return normalizeRows(res.rows);
}

// Requests currently awaiting this person's decision — either as the
// resolved level-1 manager, or as one of the fixed final approvers.
async function listPendingFor(userEmail) {
  if (isFinalApprover(userEmail)) {
    const res = await getDb().execute({ sql: "SELECT * FROM leave_requests WHERE status = 'pending_final' ORDER BY start_date ASC" });
    return normalizeRows(res.rows);
  }
  const res = await getDb().execute({
    sql: "SELECT * FROM leave_requests WHERE status = 'pending_manager' AND LOWER(level1_approver_email) = LOWER(?) ORDER BY start_date ASC",
    args: [userEmail]
  });
  return normalizeRows(res.rows);
}

async function decide(id, approverEmail, decision, note) {
  const db = getDb();
  const request = await getRequest(id);
  if (!request) throw new Error('Leave request not found');

  if (request.status === 'pending_manager') {
    if (request.level1_approver_email?.toLowerCase() !== approverEmail.toLowerCase()) {
      throw new Error('You are not the approver for this request');
    }
    if (decision === 'reject') {
      await db.execute({ sql: "UPDATE leave_requests SET status = 'rejected', level1_decided_by = ?, level1_decided_at = now(), decision_note = ?, updated_at = now() WHERE id = ?", args: [approverEmail, note || null, id] });
    } else {
      await db.execute({ sql: "UPDATE leave_requests SET status = 'pending_final', level1_decided_by = ?, level1_decided_at = now(), updated_at = now() WHERE id = ?", args: [approverEmail, id] });
    }
  } else if (request.status === 'pending_final') {
    if (!isFinalApprover(approverEmail)) throw new Error('You are not an approver for this request');
    const newStatus = decision === 'reject' ? 'rejected' : 'approved';
    await db.execute({ sql: 'UPDATE leave_requests SET status = ?, level2_decided_by = ?, level2_decided_at = now(), decision_note = ?, updated_at = now() WHERE id = ?', args: [newStatus, approverEmail, note || null, id] });
  } else {
    throw new Error('This request has already been decided');
  }

  return getRequest(id);
}

// Approved leave overlapping [from, to] (inclusive), for the team calendar.
async function listApprovedInRange(from, to) {
  const res = await getDb().execute({
    sql: "SELECT id, user_email, user_name, start_date, end_date FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ? ORDER BY start_date ASC",
    args: [to, from]
  });
  return normalizeRows(res.rows);
}

// Full history for admin oversight — not scoped to any one approver/requester.
async function listAll() {
  const res = await getDb().execute('SELECT * FROM leave_requests ORDER BY created_at DESC');
  return normalizeRows(res.rows);
}

module.exports = { MIN_NOTICE_DAYS, earliestSelectableDate, isFinalApprover, FINAL_APPROVERS, createRequest, getRequest, listMine, listPendingFor, decide, listApprovedInRange, listAll };
