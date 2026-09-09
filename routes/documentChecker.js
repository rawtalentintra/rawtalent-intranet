const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
const { extractText, runCheck, invalidateRequirementCache } = require('../services/documentCheckerService');

// Compliance documents are sensitive — admin/super_admin only for now,
// same tier as everything else touching candidate/educator personal data.
router.use(requireAdmin);

// Only RT's own requirementName strings that have a real rule set in
// documentCheckerService.js map to something — everything else on a
// candidate's Documents list (Passport, Qualification, Agency Payslip, etc.)
// shows as "not yet supported" in the UI rather than silently failing or
// guessing.
//
// Phase 1 (2026-09-09) — grounded in a live query against real production
// rt_candidates_cache.raw->'attachedRequirements' (19 distinct real
// requirementName+documentId pairs), not guessed labels. Several different
// RT strings intentionally map to the SAME internal type — RT names each
// state's card differently (or not at all — some are just the generic
// "Working with Children's Check (WwCC)"/"Working with Children Check") —
// but which compliance_requirements row actually applies is resolved by the
// candidate's own real state at check time (see documentCheckerService.js's
// makeExpiringDocumentChecker), never by which RT label was used. The two
// distinct RT Child Safety Training labels ("Foundations"/"Advanced") both
// map to one 'child_safety_training' type — see schema.sql's
// cr-all-child-safety row for why.
// Real Bug fix (2026-09-09) — the three RT labels below use a CURLY
// apostrophe (’ U+2019), not a straight one ('). Confirmed against the
// literal Unicode codepoints of real production requirementName values —
// every one of these three was silently NEVER matching a single real
// document until this fix, because the straight-apostrophe versions first
// shipped in this map can never equal RT's actual curly-apostrophe strings.
const REQUIREMENT_NAME_TO_TYPE = {
  'Police Check': 'police_check',
  'Working with Children’s Check (WwCC)': 'wwcc',
  'Working with Children’s Check (NSW)': 'wwcc',
  'Working with Children’s Check (SA)': 'wwcc',
  'Working with Children Check': 'wwcc',
  'Working with Vulnerable People Card': 'wwcc',
  'Registration to Work with Vulnerable People': 'wwcc',
  'Blue Card': 'blue_card',
  'First Aid': 'first_aid',
  'Foundations of Child Safety Training': 'child_safety_training',
  'Advanced Child Safety Training': 'child_safety_training',
  // NOT 'wwcc' — opened a real one of these (2026-09-09) and it's actually a
  // Mandatory Reporting training-course completion certificate, not
  // Victoria's government WWCC card. See schema.sql's
  // cr-vic-protecting-children-training row and documentCheckerService.js's
  // checkProtectingChildrenTraining for the full reasoning.
  'Protecting Children Certificate (VIC Only)': 'protecting_children_training'
};

// Documents are never uploaded here — they're fetched server-side from the
// URL RT already gives us on the candidate's own attachedRequirements[]
// (documentPath, an S3 link). Restricting fetches to RT's own document
// host stops this from becoming an open URL-fetch proxy for whoever calls
// it — an admin session is already required, but this is a second,
// independent guard against the one thing that gate doesn't cover (this
// route making an unexpected outbound request on the server's behalf).
const ALLOWED_DOCUMENT_HOSTS = /(^|\.)amazonaws\.com$/i;

async function fetchRtDocument(documentPath) {
  let url;
  try { url = new URL(documentPath); } catch { throw new Error('Invalid document URL'); }
  if (!ALLOWED_DOCUMENT_HOSTS.test(url.hostname)) {
    throw new Error(`Refusing to fetch a document from an unrecognised host (${url.hostname})`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the document from RT (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const filename = decodeURIComponent(url.pathname.split('/').pop() || 'document');
  return { buffer, filename };
}

// ── Compliance Rules (Phase 0) ──────────────────────────────────────
// The structured, state-by-document-type rule set every checker in
// documentCheckerService.js reads its validity period from — see
// compliance_requirements' own schema.sql comment for the full reasoning.
// Plain CRUD, admin-editable, no AI anywhere near it.
router.get('/requirements', async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM compliance_requirements ORDER BY document_type, state');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const REQUIREMENT_FIELDS = ['state', 'document_type', 'display_name', 'required', 'expiry_source', 'validity_days', 'verified', 'source_note', 'source_url', 'notes'];
const EXPIRY_SOURCES = new Set(['computed', 'printed_on_document', 'no_expiry']);

router.post('/requirements', async (req, res) => {
  const { state, document_type, display_name, expiry_source } = req.body;
  if (!state?.trim() || !document_type?.trim() || !display_name?.trim()) {
    return res.status(400).json({ error: 'state, document_type, and display_name are required' });
  }
  if (expiry_source && !EXPIRY_SOURCES.has(expiry_source)) {
    return res.status(400).json({ error: `expiry_source must be one of: ${[...EXPIRY_SOURCES].join(', ')}` });
  }
  try {
    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO compliance_requirements
              (id, state, document_type, display_name, required, expiry_source, validity_days, verified, source_note, source_url, notes, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, state.trim().toUpperCase(), document_type.trim(), display_name.trim(),
        req.body.required !== false, expiry_source || 'computed', req.body.validity_days ?? null, !!req.body.verified,
        req.body.source_note || null, req.body.source_url || null, req.body.notes || null,
        req.user.email, req.user.email
      ]
    });
    invalidateRequirementCache();
    const row = (await getDb().execute({ sql: 'SELECT * FROM compliance_requirements WHERE id = ?', args: [id] })).rows[0];
    res.json(row);
  } catch (err) {
    // Most likely the (state, document_type) unique index — surfaced as a
    // normal validation error rather than a raw 500, since "this state/
    // type combo already has a row" is an expected, correctable mistake.
    res.status(err.message?.includes('duplicate key') ? 409 : 500).json({ error: err.message?.includes('duplicate key') ? 'A requirement already exists for this state and document type — edit that row instead.' : err.message });
  }
});

router.put('/requirements/:id', async (req, res) => {
  if (req.body.expiry_source && !EXPIRY_SOURCES.has(req.body.expiry_source)) {
    return res.status(400).json({ error: `expiry_source must be one of: ${[...EXPIRY_SOURCES].join(', ')}` });
  }
  const sets = [];
  const args = [];
  for (const field of REQUIREMENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      sets.push(`${field} = ?`);
      args.push(field === 'state' ? String(req.body[field]).toUpperCase() : req.body[field]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  sets.push('updated_by = ?', 'updated_at = now()');
  args.push(req.user.email, req.params.id);
  try {
    const result = await getDb().execute({ sql: `UPDATE compliance_requirements SET ${sets.join(', ')} WHERE id = ?`, args });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Requirement not found' });
    invalidateRequirementCache();
    const row = (await getDb().execute({ sql: 'SELECT * FROM compliance_requirements WHERE id = ?', args: [req.params.id] })).rows[0];
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/requirements/:id', requireSuperAdmin, async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'DELETE FROM compliance_requirements WHERE id = ?', args: [req.params.id] });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Requirement not found' });
    invalidateRequirementCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The whole point of this feature is avoiding AI credits — OCR (free,
// self-hosted Tesseract) plus a deterministic rule set derived from our own
// SOPs (see services/documentCheckerService.js). No AI call anywhere in
// this route. One row per check run (append-only — see schema.sql), so
// re-checking a document after RT shows an updated file just adds a new
// row rather than overwriting the last result.
//
// Extracted (Phase 5, 2026-09-09) so both the single "Check Document"
// button (below) and services/documentCheckerBulkService.js's bulk sweep
// call the exact same logic — the bulk runner is not a separate,
// parallel-maintained copy of this. `bulkRunId` is null for a normal
// single check, set for one produced by a sweep.
async function performDocumentCheck({ candidateId, candidateName, candidateState, userDocumentDetailId, requirementName, documentPath, checkedByEmail, checkedByName, bulkRunId = null }) {
  const documentType = REQUIREMENT_NAME_TO_TYPE[requirementName];
  if (!documentType) throw new Error(`No automated check is available yet for "${requirementName}"`);

  const { buffer, filename } = await fetchRtDocument(documentPath);
  const { text, method, confidence, quality, pdfMetadata } = await extractText(buffer, filename);
  if (!text) throw new Error('No readable text could be extracted from this document.');

  // candidateState threaded through for the state-specific checkers Phase 1
  // adds (WWCC/Blue Card/etc.) — Police Check's own requirement row is
  // state-independent ('ALL') so it's a no-op for it today. confidence/
  // quality threaded through for Phase 2's photo-quality checks,
  // pdfMetadata for Phase 4's document-integrity checks — all applied once,
  // centrally, inside runCheck itself, not duplicated per document type.
  const result = await runCheck(documentType, text, { candidateName: candidateName || null, state: candidateState || null, confidence, quality, pdfMetadata });

  const db = getDb();
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const id = uuidv4();
  await db.execute({
    sql: `INSERT INTO document_checks (
            id, document_type, filename, extraction_method, ocr_confidence,
            candidate_name_input, outcome, flags, reasons, extracted_fields, extracted_text,
            checked_by_email, checked_by_name,
            candidate_id, user_document_detail_id, requirement_name, document_source_url, file_hash, bulk_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, documentType, filename, method, confidence,
      candidateName || null, result.outcome, JSON.stringify(result.flags), JSON.stringify(result.reasons),
      JSON.stringify(result.extracted), text.slice(0, 20000),
      checkedByEmail, checkedByName || checkedByEmail,
      candidateId, userDocumentDetailId, requirementName, documentPath, fileHash, bulkRunId
    ]
  });

  // Cross-candidate duplicate-file check (Phase 4) — the one fake-document
  // heuristic that's 100% deterministic, no threshold to get wrong: the
  // exact same file (by content hash, not filename/path — RT gives every
  // upload its own S3 path regardless of content) already used for a
  // DIFFERENT real candidate is a strong, specific signal on its own. Only
  // ever pulls a clean 'valid' down to 'needs_review', same as every other
  // heuristic — a human decides what a duplicate actually means, this just
  // makes sure they see it.
  //
  // Real bug (found 2026-09-09, stress-testing): this used to run BEFORE
  // the insert above — a check-then-act race. Reproduced empirically: 3
  // concurrent check-from-rt calls for the exact same file, and one of
  // them missed the other two entirely, because its own "does a row for
  // this hash already exist" query ran before either of the others had
  // committed their INSERT. Running this AFTER the insert instead closes
  // that window — it now reads against the row set that includes this
  // call's own just-written row, so a companion request's row (if its
  // insert already landed) is visible. Any residual near-simultaneous miss
  // is self-healing: the very next check-from-rt call on that file (a
  // manual re-check, or reviewing a sibling candidate later) will see the
  // complete row set and correctly flag it retroactively — the only
  // window is a same-instant race, never a permanent miss.
  const dup = (await db.execute({
    sql: `SELECT candidate_id, candidate_name_input, created_at FROM document_checks
          WHERE file_hash = ? AND candidate_id IS NOT NULL AND candidate_id != ? ORDER BY created_at ASC LIMIT 1`,
    args: [fileHash, candidateId]
  })).rows[0];
  if (dup) {
    result.flags.push('duplicate_document_across_candidates');
    result.reasons.push(`This exact file was already used for a different candidate (${dup.candidate_name_input || `ID ${dup.candidate_id}`}) on ${new Date(dup.created_at).toLocaleDateString('en-AU')} — check this isn't a reused or shared document.`);
    if (result.outcome === 'valid') result.outcome = 'needs_review';
    await db.execute({
      sql: `UPDATE document_checks SET flags = ?, reasons = ?, outcome = ? WHERE id = ?`,
      args: [JSON.stringify(result.flags), JSON.stringify(result.reasons), result.outcome, id]
    });
  }

  return { id, extractionMethod: method, ocrConfidence: confidence, reviewed: false, ...result };
}

router.post('/check-from-rt', async (req, res) => {
  const { candidateId, candidateName, candidateState, userDocumentDetailId, requirementName, documentPath } = req.body;
  if (!candidateId || !userDocumentDetailId || !requirementName || !documentPath) {
    return res.status(400).json({ error: 'candidateId, userDocumentDetailId, requirementName, and documentPath are required' });
  }
  try {
    const result = await performDocumentCheck({
      candidateId, candidateName, candidateState, userDocumentDetailId, requirementName, documentPath,
      checkedByEmail: req.user.email, checkedByName: req.user.name
    });
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// Every real RT requirementName that maps to a supported internal type —
// the same map check-from-rt uses server-side, exposed read-only so the
// frontend's Compliance Gaps panel (admin.html) can tell "has a document,
// but of an unsupported type" apart from "genuinely missing the document
// entirely" without duplicating this list client-side and risking the two
// silently drifting apart.
router.get('/type-map', (req, res) => {
  res.json(REQUIREMENT_NAME_TO_TYPE);
});

// The latest check per requirement for one candidate — what the Candidate
// Documents tab renders. DISTINCT ON picks the newest row per
// user_document_detail_id in one query rather than the app filtering a
// full history client-side.
router.get('/for-candidate/:candidateId', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: `SELECT DISTINCT ON (user_document_detail_id) *
            FROM document_checks
            WHERE candidate_id = ?
            ORDER BY user_document_detail_id, created_at DESC`,
      args: [req.params.candidateId]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Human confirms/annotates one specific automated result — reviewed and
// review_notes belong to that check row, not the requirement in general,
// so a fresh re-check naturally starts unreviewed again rather than
// silently inheriting an approval that was given to a different file.
router.put('/:id/review', async (req, res) => {
  const { reviewed, notes } = req.body;
  try {
    const result = await getDb().execute({
      sql: `UPDATE document_checks SET reviewed = ?, reviewed_by = ?, reviewed_at = now(), review_notes = ? WHERE id = ?`,
      args: [!!reviewed, req.user.email, (notes || '').trim() || null, req.params.id]
    });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Check not found' });
    const row = (await getDb().execute({ sql: 'SELECT * FROM document_checks WHERE id = ?', args: [req.params.id] })).rows[0];
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit log across every candidate — not the primary workflow (that's the
// candidate's own Documents tab) but useful for oversight of what's been
// checked and by whom.
router.get('/history', async (req, res) => {
  try {
    const result = await getDb().execute(
      `SELECT id, document_type, filename, extraction_method, ocr_confidence, candidate_name_input, candidate_id,
              requirement_name, outcome, flags, reasons, extracted_fields, reviewed, reviewed_by, reviewed_at,
              review_notes, checked_by_email, checked_by_name, created_at, document_source_url
       FROM document_checks ORDER BY created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Flagged Profiles (Phase 6, 2026-09-09) — which real candidates currently
// have an unresolved compliance concern, grouped so a reviewer sees "these
// 12 people need attention" at a glance instead of scrolling the full
// history table looking for outcome != 'valid'. Built on the LATEST check
// per (candidate, document) only — document_checks is append-only, so a
// document that was flagged once but has since been re-checked and passed
// must not still count it as flagged forever off stale history. "reviewed"
// clears an item from this list even if the outcome itself is still
// needs_review/invalid — reviewed means a human has actually looked at it,
// which is the whole point of this list (surfacing what nobody has looked
// at yet), not "outcome is currently clean".
router.get('/flagged', async (req, res) => {
  try {
    const result = await getDb().execute(`
      WITH latest AS (
        SELECT DISTINCT ON (candidate_id, user_document_detail_id) *
        FROM document_checks
        WHERE candidate_id IS NOT NULL
        ORDER BY candidate_id, user_document_detail_id, created_at DESC
      )
      SELECT candidate_id,
             (array_agg(candidate_name_input ORDER BY created_at DESC))[1] AS candidate_name,
             COUNT(*) AS flagged_count,
             array_agg(DISTINCT outcome) AS outcomes,
             array_agg(DISTINCT requirement_name ORDER BY requirement_name) AS flagged_documents,
             MAX(created_at) AS most_recent_at
      FROM latest
      WHERE outcome IN ('needs_review', 'invalid') AND reviewed = false
      GROUP BY candidate_id
      ORDER BY most_recent_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deleting the audit record outright (not just archiving) is kept to
// super_admin, same as the other hard-delete actions in this app.
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM document_checks WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk automation (Phase 5) ────────────────────────────────────────
// A full sweep hits RT-cached data for potentially hundreds of candidates
// and runs a real OCR check per document — restricted to super_admin, same
// justification as Reports' own "Sync Now" (routes/reports.js): routine use
// doesn't need this, "I need this run right now" does. Runs in the
// background and responds immediately, same fire-and-forget + poll pattern
// as rt_candidates_sync_state — see services/documentCheckerBulkService.js.
const bulkService = require('../services/documentCheckerBulkService');

router.post('/bulk-check', requireSuperAdmin, async (req, res) => {
  try {
    const latest = await bulkService.getLatestBulkRun();
    if (bulkService.isBulkRunning(latest)) {
      return res.status(409).json({ error: `A bulk sweep is already in progress (started ${latest.started_at}).` });
    }
    // performDocumentCheck/REQUIREMENT_NAME_TO_TYPE passed in rather than
    // required back from bulkService — this file already requires
    // bulkService above; having bulkService require this file too would be
    // a circular require, resolved unreliably depending on which module
    // finishes loading first. Passing them as plain arguments avoids that
    // entirely.
    const runId = await bulkService.startBulkRun(req.body.state || 'ALL', req.user.email, { performDocumentCheck, REQUIREMENT_NAME_TO_TYPE });
    res.json({ started: true, runId });
  } catch (err) {
    // 409 for the race-lost case too (bulkService throws this exact
    // message when the DB's own unique-running-row guarantee is what
    // actually caught it, not the pre-check above) — same status a caller
    // would get from the common, non-racing "already running" path.
    res.status(err.message === 'A bulk sweep is already in progress.' ? 409 : 500).json({ error: err.message });
  }
});

router.get('/bulk-check/status', async (req, res) => {
  try {
    const latest = await bulkService.getLatestBulkRun();
    res.json(latest ? { ...latest, isRunning: bulkService.isBulkRunning(latest) } : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bulk-check/:runId/results', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: `SELECT id, document_type, filename, candidate_name_input, candidate_id, requirement_name,
                   outcome, flags, reasons, reviewed, created_at
            FROM document_checks WHERE bulk_run_id = ? ORDER BY created_at DESC`,
      args: [req.params.runId]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// Express Router is a plain function, so attaching extra properties here
// doesn't interfere with app.js's app.use('/api/document-checker',
// require('./routes/documentChecker')) — kept for direct testability
// against real data without going through HTTP. Not used by
// documentCheckerBulkService.js itself (that gets these passed as plain
// arguments instead — see the /bulk-check route above for why: this file
// already requires that service, so having it require this file back would
// be a circular require).
module.exports.performDocumentCheck = performDocumentCheck;
module.exports.REQUIREMENT_NAME_TO_TYPE = REQUIREMENT_NAME_TO_TYPE;
