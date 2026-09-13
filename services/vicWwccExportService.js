const { getDb } = require('../db/database');
const { WWCC_NUMBER_PATTERNS } = require('./documentCheckerService');

// ── VIC WWCC Bulk Check export (2026-09-13) ─────────────────────────────
// Automates the DATA side of Sophia's real "SOP: VIC WWCC - Bulk Check" —
// specifically steps 2-6 (get the report, review it, reformat the WWCC
// number, quality-check it, finalise the file). What it deliberately does
// NOT do is steps 7-8 (uploading to Service Victoria's own bulk-check tool
// and reviewing the results): that page has a live reCAPTCHA (confirmed by
// opening it directly, 2026-09-13), and this app will never build anything
// that bypasses or solves a CAPTCHA — Joy asked directly and was told no.
// A human still uploads the file this produces and reads the results.
//
// The SOP's own workflow waits on a daily report from IT and reformats it
// by hand in Sheets (REGEXREPLACE(B2,"-.*$","") to strip the "-01" suffix
// off "1234567A-01" → "1234567A"). This reads the exact same underlying
// data (educator name + WWCC number) straight from rt_candidates_cache —
// the same nightly RT sync every other compliance feature in this app
// already relies on — so there's no need to wait on IT's separate report
// at all for the data-prep half of this process.
function reformatVicWwccNumber(raw) {
  return String(raw).trim().replace(/-.*/, '').toUpperCase();
}

// One row per candidate/requirement pairing goes into one of five buckets.
// Ambiguous cases (multiple WWCC records on one profile, or the same
// reformatted number shared by two different educators) are surfaced for a
// human to resolve, never silently picked for them — same "surface it,
// don't decide for a human" principle the rest of Document Checker already
// follows for its own fake-document/quality flags.
async function buildVicWwccExportReport() {
  const db = getDb();
  // REQUIREMENT_NAME_TO_TYPE is routes/documentChecker.js's own verified
  // mapping from RT's real requirementName strings to internal document
  // types — lazily required (not at module top level) to avoid a circular
  // require, same reasoning as documentCheckerAiFallbackService.js's own
  // lazy require of fetchRtDocument from that same file.
  const { REQUIREMENT_NAME_TO_TYPE } = require('../routes/documentChecker');
  const vicPattern = WWCC_NUMBER_PATTERNS.VIC.pattern;

  // regionId 4 = VIC (CANDIDATE_REGION_TO_STATE, confirmed against all
  // 24,927 real candidates' cleaned state text, 2026-09-10). Only Enabled
  // (is_active/is_deleted — RT's own account-disabled toggle, not the
  // vetting `status` field) educators are in scope, same convention as the
  // CPR expiry sweep run the same week.
  const rows = (await db.execute(`
    SELECT user_id, first_name, last_name, email, raw->'attachedRequirements' AS attached_requirements
    FROM rt_candidates_cache
    WHERE is_active = true AND is_deleted IS NOT TRUE
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(raw->'addresses','[]'::jsonb)) a
        WHERE (a->>'regionId')::int = 4
      )
  `)).rows;

  const withWwcc = rows
    .map(r => ({ ...r, wwccRequirements: (r.attached_requirements || []).filter(req => REQUIREMENT_NAME_TO_TYPE[req.requirementName] === 'wwcc') }))
    .filter(r => r.wwccRequirements.length > 0);

  const ready = [], blank = [], malformed = [], multipleRecords = [];
  for (const c of withWwcc) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed educator';
    const base = { userId: c.user_id, name, email: c.email, lastName: c.last_name };

    if (c.wwccRequirements.length > 1) {
      multipleRecords.push({ ...base, recordCount: c.wwccRequirements.length });
      continue;
    }
    const rawNumber = (c.wwccRequirements[0].documentNumber || '').trim();
    if (!rawNumber) {
      blank.push(base);
      continue;
    }
    if (!vicPattern.test(rawNumber)) {
      malformed.push({ ...base, rawNumber });
      continue;
    }
    ready.push({ ...base, rawNumber, cardNumber: reformatVicWwccNumber(rawNumber) });
  }

  // A duplicate reformatted number across two DIFFERENT educators is a
  // real red flag worth a human's eyes (most likely a copy/paste mistake
  // during data entry) — pulled out of "ready" rather than exported as-is.
  const byCardNumber = {};
  ready.forEach(r => { (byCardNumber[r.cardNumber] = byCardNumber[r.cardNumber] || []).push(r); });
  const duplicateNumbers = Object.values(byCardNumber).filter(g => g.length > 1).flat();
  const duplicateUserIds = new Set(duplicateNumbers.map(r => r.userId));
  const cleanReady = ready.filter(r => !duplicateUserIds.has(r.userId));

  return {
    generatedAt: new Date().toISOString(),
    totalVicEducators: rows.length,
    withWwccRequirement: withWwcc.length,
    ready: cleanReady,
    blank,
    malformed,
    multipleRecords,
    duplicateNumbers
  };
}

// Matches the real Service Victoria bulk-checker's own stated CSV
// requirement exactly (confirmed live, 2026-09-13, on the actual upload
// step of https://service.vic.gov.au/services/working-with-children-check-status-checker/transaction):
// two columns, "family name" and "card number", nothing else.
function toCsv(rows) {
  const esc = v => (/[,"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const lines = [['family name', 'card number'].join(',')];
  rows.forEach(r => lines.push([esc(r.lastName || r.name), esc(r.cardNumber)].join(',')));
  return lines.join('\n');
}

module.exports = { buildVicWwccExportReport, toCsv, reformatVicWwccNumber };
