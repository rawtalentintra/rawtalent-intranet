const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { isFinalApprover } = require('./leaveService');
const timesheet = require('./timesheetService');
const { buildPayslipPdf } = require('./payslipPdfService');
const { BUCKETS, ensureBucket, uploadBuffer, downloadAsBuffer, remove: removeFile } = require('./storageService');

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

// pg returns DATE columns as JS Date objects built from the server's local
// timezone — naive serialization shifts the date. Same fix as
// leaveService.js/timesheetService.js's toDateOnly.
function toDateOnly(v) {
  if (!v) return v;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}
function normalizePayslip(row) {
  if (!row) return row;
  return { ...row, pay_period_start: toDateOnly(row.pay_period_start), pay_period_end: toDateOnly(row.pay_period_end), date_paid: toDateOnly(row.date_paid) };
}

// "July 6 - 10, 2026" / "June 29 - July 5, 2026" — matches the real
// template's week-range label exactly for both same-month and
// month-crossing weeks.
function fmtRangeLabel(startStr, endStr) {
  const s = new Date(`${startStr}T00:00:00`);
  const e = new Date(`${endStr}T00:00:00`);
  const startMonth = s.toLocaleDateString('en-AU', { month: 'long' });
  const endMonth = e.toLocaleDateString('en-AU', { month: 'long' });
  if (startMonth === endMonth) return `${startMonth} ${s.getDate()} - ${e.getDate()}, ${e.getFullYear()}`;
  return `${startMonth} ${s.getDate()} - ${endMonth} ${e.getDate()}, ${e.getFullYear()}`;
}

async function getProfile(userEmail) {
  const res = await getDb().execute({ sql: 'SELECT * FROM employee_payroll_profiles WHERE LOWER(user_email) = LOWER(?)', args: [userEmail] });
  return res.rows[0] || null;
}

// Every active team member with a real login (Prince/Yuv have no login —
// confirmed out of scope — and are naturally excluded by the users JOIN,
// no special-case filter needed), left-joined with whatever payroll
// profile fields exist so far (null if not yet set up).
async function listProfiles() {
  const res = await getDb().execute(`
    SELECT tm.email AS user_email, tm.name, tm.legal_name, tm.position, tm.address,
           epp.hourly_rate_aud, epp.pays_in_php, epp.bank_name, epp.bank_account_name, epp.bank_account_number, epp.bank_swift_code
    FROM team_members tm
    JOIN users u ON LOWER(u.email) = LOWER(tm.email) AND u.active = true
    LEFT JOIN employee_payroll_profiles epp ON LOWER(epp.user_email) = LOWER(tm.email)
    WHERE tm.status = 'active'
    ORDER BY tm.name ASC
  `);
  return res.rows;
}

async function upsertProfile({ userEmail, userName, hourlyRateAud, paysInPhp, bankName, bankAccountName, bankAccountNumber, bankSwiftCode, updatedBy }) {
  await getDb().execute({
    sql: `INSERT INTO employee_payroll_profiles (id, user_email, user_name, hourly_rate_aud, pays_in_php, bank_name, bank_account_name, bank_account_number, bank_swift_code, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_email) DO UPDATE SET user_name = excluded.user_name, hourly_rate_aud = excluded.hourly_rate_aud,
            pays_in_php = excluded.pays_in_php, bank_name = excluded.bank_name, bank_account_name = excluded.bank_account_name,
            bank_account_number = excluded.bank_account_number, bank_swift_code = excluded.bank_swift_code,
            updated_by = excluded.updated_by, updated_at = now()`,
    args: [uuidv4(), userEmail, userName, hourlyRateAud, !!paysInPhp, bankName || null, bankAccountName || null, bankAccountNumber || null, bankSwiftCode || null, updatedBy]
  });
  return getProfile(userEmail);
}

async function getEmployeeMeta(userEmail) {
  const res = await getDb().execute({ sql: 'SELECT name, legal_name, position, address FROM team_members WHERE LOWER(email) = LOWER(?)', args: [userEmail] });
  const row = res.rows[0] || {};
  return { legalNameOrName: row.legal_name || row.name || userEmail, position: row.position || '', address: row.address || '' };
}

// Real external numbering (from before this app existed) is already in
// the 40s — this is a suggestion, not a hard sequence. See db/schema.sql's
// comment on payslips.invoice_number for why it's a plain UNIQUE integer.
async function suggestedInvoiceNumber() {
  const res = await getDb().execute('SELECT COALESCE(MAX(invoice_number),0) AS max FROM payslips');
  return Number(res.rows[0].max) + 1;
}

// "Payroll approved" = both timesheet_weeks rows for this pay period are
// status='approved'. Reuses timesheetService.getWeek directly rather than
// re-querying timesheet_weeks here.
async function listEligibleForPeriod(payPeriodStart) {
  const db = getDb();
  const roster = await listProfiles();
  const week2Start = addDays(payPeriodStart, 7);
  const results = [];
  for (const person of roster) {
    const [w1, w2, existingRes] = await Promise.all([
      timesheet.getWeek(person.user_email, payPeriodStart),
      timesheet.getWeek(person.user_email, week2Start),
      db.execute({ sql: 'SELECT id, published_at FROM payslips WHERE LOWER(user_email) = LOWER(?) AND pay_period_start = ?', args: [person.user_email, payPeriodStart] })
    ]);
    const bothApproved = w1.week.status === 'approved' && w2.week.status === 'approved';
    const hasProfile = person.hourly_rate_aud != null;
    const existing = existingRes.rows[0];
    results.push({
      userEmail: person.user_email, userName: person.legal_name || person.name, position: person.position,
      week1Status: w1.week.status, week2Status: w2.week.status, bothApproved, hasProfile,
      existingPayslipId: existing?.id || null, alreadyPublished: !!existing?.published_at,
      eligible: bothApproved && hasProfile
    });
  }
  return results;
}

// Auto-fills the two Week N line items from real approved hours × the
// employee's stored rate — Sophia/Joy add anything extra (Training,
// Sunday Shift, bonuses) by hand, since the timesheet system has no
// shift-type tagging to derive those from.
async function buildLineItemsFromTimesheets(userEmail, payPeriodStart) {
  const week2Start = addDays(payPeriodStart, 7);
  const [w1, w2, profile] = await Promise.all([
    timesheet.getWeek(userEmail, payPeriodStart),
    timesheet.getWeek(userEmail, week2Start),
    getProfile(userEmail)
  ]);
  const rate = Number(profile?.hourly_rate_aud || 0);
  const h1 = Number(w1.week.total_hours || 0);
  const h2 = Number(w2.week.total_hours || 0);
  const lineItems = [
    { groupLabel: `Week 1: ${fmtRangeLabel(payPeriodStart, w1.week.week_end_date)}`, label: '', hours: h1, rate, amount: round2(h1 * rate), source: 'timesheet' },
    { groupLabel: `Week 2: ${fmtRangeLabel(week2Start, w2.week.week_end_date)}`, label: '', hours: h2, rate, amount: round2(h2 * rate), source: 'timesheet' }
  ];
  const workedDays = new Set([...w1.entries, ...w2.entries].filter(e => Number(e.hours) > 0).map(e => e.entry_date)).size;
  return { lineItems, workedDays, week1Status: w1.week.status, week2Status: w2.week.status };
}

async function getById(id) {
  const res = await getDb().execute({ sql: 'SELECT * FROM payslips WHERE id = ?', args: [id] });
  return normalizePayslip(res.rows[0]);
}

async function previewPdf(draft) {
  const { userEmail, payPeriodStart, invoiceNumber, datePaid, workedDays, lineItems, exchangeRate, totalEarningsPhp } = draft;
  const [profile, meta] = await Promise.all([getProfile(userEmail), getEmployeeMeta(userEmail)]);
  const p = profile || {};
  const payPeriodEnd = timesheet.payPeriodEndOf(payPeriodStart);
  const totalEarningsAud = lineItems.reduce((sum, li) => sum + Number(li.amount || 0), 0);
  return buildPayslipPdf({
    invoiceNumber, referenceNo: `RawTalent${String(invoiceNumber).padStart(4, '0')}`, userName: meta.legalNameOrName, designation: meta.position, address: meta.address,
    payPeriodStart, payPeriodEnd, datePaid, workedDays, lineItems, totalEarningsAud,
    exchangeRate: p.pays_in_php ? exchangeRate : null, totalEarningsPhp: p.pays_in_php ? totalEarningsPhp : null, paysInPhp: !!p.pays_in_php
  }, p);
}

// Re-validates everything server-side rather than trusting the UI's
// earlier eligibility check or client-sent total — a client-tampered
// total on a financial document is exactly the kind of bug that needs to
// be structurally prevented.
async function generate({ userEmail, payPeriodStart, invoiceNumber, datePaid, workedDays, lineItems, exchangeRate, totalEarningsPhp, createdBy }) {
  const db = getDb();
  const week2Start = addDays(payPeriodStart, 7);
  const [w1, w2, profile, meta] = await Promise.all([
    timesheet.getWeek(userEmail, payPeriodStart),
    timesheet.getWeek(userEmail, week2Start),
    getProfile(userEmail),
    getEmployeeMeta(userEmail)
  ]);
  if (w1.week.status !== 'approved' || w2.week.status !== 'approved') {
    throw new Error('Both weeks of this pay period must be fully approved before generating a payslip');
  }
  if (!profile || profile.hourly_rate_aud == null) {
    throw new Error("Set this employee's hourly rate (and bank details) before generating a payslip");
  }
  if (profile.pays_in_php && (exchangeRate == null || totalEarningsPhp == null)) {
    throw new Error('Exchange rate and PHP total are required for this employee');
  }
  if (!lineItems || !lineItems.length) throw new Error('Add at least one line item');

  const payPeriodEnd = timesheet.payPeriodEndOf(payPeriodStart);
  const totalEarningsAud = round2(lineItems.reduce((sum, li) => sum + Number(li.amount || 0), 0));

  const pdfBuffer = await buildPayslipPdf({
    invoiceNumber, referenceNo: `RawTalent${String(invoiceNumber).padStart(4, '0')}`, userName: meta.legalNameOrName, designation: meta.position, address: meta.address,
    payPeriodStart, payPeriodEnd, datePaid, workedDays, lineItems, totalEarningsAud,
    exchangeRate: profile.pays_in_php ? exchangeRate : null, totalEarningsPhp: profile.pays_in_php ? totalEarningsPhp : null, paysInPhp: profile.pays_in_php
  }, profile);

  const id = uuidv4();
  const storagePath = `${id}.pdf`;
  await ensureBucket(BUCKETS.payslips);
  await uploadBuffer(BUCKETS.payslips, storagePath, pdfBuffer, 'application/pdf');

  try {
    await db.execute({
      sql: `INSERT INTO payslips (id, invoice_number, user_email, user_name, pay_period_start, pay_period_end, date_paid, worked_days, line_items, total_earnings_aud, exchange_rate, total_earnings_php, storage_path, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, invoiceNumber, userEmail, meta.legalNameOrName, payPeriodStart, payPeriodEnd, datePaid, workedDays, JSON.stringify(lineItems), totalEarningsAud,
        profile.pays_in_php ? exchangeRate : null, profile.pays_in_php ? totalEarningsPhp : null, storagePath, createdBy]
    });
  } catch (err) {
    await removeFile(BUCKETS.payslips, storagePath).catch(() => {});
    // invoice_number is deliberately not unique (see schema comment) — the
    // same number repeats across every payslip in a pay run — so the only
    // real collision guard left is one payslip per person per period.
    if (/duplicate key/i.test(err.message) && /pay_period_start/i.test(err.message)) throw new Error('A payslip for this employee and pay period already exists');
    throw err;
  }
  return getById(id);
}

async function publish(id) {
  const row = await getById(id);
  if (!row) throw new Error('Payslip not found');
  if (!row.storage_path) throw new Error('This payslip has no generated PDF');
  await getDb().execute({ sql: 'UPDATE payslips SET published_at = now(), updated_at = now() WHERE id = ?', args: [id] });
  return getById(id);
}
async function unpublish(id) {
  await getDb().execute({ sql: 'UPDATE payslips SET published_at = NULL, updated_at = now() WHERE id = ?', args: [id] });
  return getById(id);
}

async function listMine(userEmail) {
  const res = await getDb().execute({
    sql: 'SELECT * FROM payslips WHERE LOWER(user_email) = LOWER(?) AND published_at IS NOT NULL ORDER BY pay_period_start DESC',
    args: [userEmail]
  });
  return res.rows.map(normalizePayslip);
}
async function listAllForAdmin() {
  const res = await getDb().execute('SELECT * FROM payslips ORDER BY created_at DESC');
  return res.rows.map(normalizePayslip);
}

async function authorizeDownload(payslipId, requestingEmail) {
  const row = await getById(payslipId);
  if (!row) throw new Error('Payslip not found');
  const isOwner = row.user_email.toLowerCase() === requestingEmail.toLowerCase();
  if (isOwner && row.published_at) return row;
  if (isFinalApprover(requestingEmail)) return row;
  throw new Error('You do not have access to this payslip');
}

// Draft-only — an issued/published financial document isn't outright
// deletable, only unpublish()-able, to preserve an audit trail (same
// reasoning leave_requests/timesheet_weeks gate destructive actions
// behind requireSuperAdmin rather than the regular approver pool).
async function deleteDraft(id) {
  const row = await getById(id);
  if (!row) throw new Error('Payslip not found');
  if (row.published_at) throw new Error('Cannot delete a published payslip — unpublish it first, then generate a corrected replacement');
  if (row.storage_path) await removeFile(BUCKETS.payslips, row.storage_path).catch(() => {});
  await getDb().execute({ sql: 'DELETE FROM payslips WHERE id = ?', args: [id] });
}

async function downloadBuffer(storagePath) {
  return downloadAsBuffer(BUCKETS.payslips, storagePath);
}

// For a DRAFT payslip, re-renders the PDF live using the row's own stored
// numbers (invoice number, line items, dates, total — never re-derived
// from timesheets, since line items may have been hand-edited before
// generating) but a FRESH profile/employee-meta fetch — so a bank-details
// or rate correction made after generating shows up on Preview right
// away, without a delete-and-regenerate round trip just to see it.
// Deliberately NOT used for a published payslip — see the /admin/preview
// route, which keeps serving that one's originally-stored PDF unchanged.
// Once issued, the document is finalized; the correction path there is
// still unpublish + generate a replacement, not a live re-render.
async function previewStoredPdf(id) {
  const row = await getById(id);
  if (!row) throw new Error('Payslip not found');
  const [profile, meta] = await Promise.all([getProfile(row.user_email), getEmployeeMeta(row.user_email)]);
  const p = profile || {};
  return buildPayslipPdf({
    invoiceNumber: row.invoice_number, referenceNo: `RawTalent${String(row.invoice_number).padStart(4, '0')}`,
    userName: meta.legalNameOrName, designation: meta.position, address: meta.address,
    payPeriodStart: row.pay_period_start, payPeriodEnd: row.pay_period_end, datePaid: row.date_paid,
    workedDays: row.worked_days, lineItems: row.line_items, totalEarningsAud: row.total_earnings_aud,
    exchangeRate: p.pays_in_php ? row.exchange_rate : null, totalEarningsPhp: p.pays_in_php ? row.total_earnings_php : null,
    paysInPhp: !!p.pays_in_php
  }, p);
}

module.exports = {
  getProfile, listProfiles, upsertProfile, getEmployeeMeta, suggestedInvoiceNumber,
  listEligibleForPeriod, buildLineItemsFromTimesheets, previewPdf, generate,
  publish, unpublish, listMine, listAllForAdmin, authorizeDownload, deleteDraft,
  getById, downloadBuffer, previewStoredPdf
};
