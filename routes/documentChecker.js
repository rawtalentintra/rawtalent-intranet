const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
const { extractText, runCheck, invalidateRequirementCache } = require('../services/documentCheckerService');
const { createTask } = require('./tasks');
const aiFallback = require('../services/documentCheckerAiFallbackService');

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
  'Protecting Children Certificate (VIC Only)': 'protecting_children_training',
  // Confirmed 2026-09-10 against real production data — 500+ real
  // candidates (overwhelmingly SA, a handful in VIC/QLD too) hold this
  // exact requirementName, a genuinely common compliance document this
  // codebase had zero support for until now.
  'RAN Training Certificate (Master/Refresher)': 'ran_training',
  // Confirmed 2026-09-10 — this exact requirementName found on real
  // candidates via a direct rt_candidates_cache query (used to find and
  // download 8 real certificates for checkQualification's own patterns).
  'Qualification/Course of Study': 'qualification',
  // Confirmed 2026-09-10 — same query pattern, used to find and download
  // 13 real documents for checkPassport's own patterns (see its own
  // comment in documentCheckerService.js for the real acceptable-type
  // and expiry-rule breakdown).
  'Passport/ Birth Certificate/ Citizenship': 'passport'
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

// ── Auto re-capture request on a bad photo (2026-09-12) ──────────────────
// The genuinely automatable version of "catch a bad photo before it's
// accepted" — that literal idea isn't buildable here: Document Checker
// never receives the original upload at all (see this file's own /check-
// from-rt and admin.html's own comment, "Documents are never uploaded
// here" — a candidate uploads directly into RT's own external portal, a
// system this app has no code access to, so there's no upload moment in
// HeartBeat to hook a client-side re-capture prompt into). What IS fully
// ours: the moment AFTER a check already flags a real quality problem
// (documentCheckerService.js's applyPhotoQualityFlags — low_ocr_confidence/
// too_dark/too_bright/low_resolution/blurry_image), whether that check ran
// from the single "Check Document" button or from the nightly bulk sweep.
// Auto-raising the re-request task right there, the instant the flag
// fires, means no reviewer has to first notice the flag buried in a result
// before deciding to ask for a better photo — the ask itself is
// automatic, only the actual re-upload (necessarily, since it happens in
// RT's own portal) still needs the candidate to act on it.
const PHOTO_QUALITY_FLAGS = new Set(['low_ocr_confidence', 'too_dark', 'too_bright', 'low_resolution', 'blurry_image']);

// Real evidence this second trigger needed to exist (2026-09-12): a real
// WWCC photo scored 53% Tesseract confidence — ABOVE MIN_OCR_CONFIDENCE
// (45), so low_ocr_confidence never fired at all — while the actual
// extracted text was pure noise for everything except the card's own
// printed heading (name/number/expiry all genuinely unreadable). A raw
// confidence-score threshold missed this because the average was dragged
// up by one perfectly-legible heading; the more reliable signal turned
// out to be semantic, not numeric: the document type WAS confirmed (so
// it's clearly the right kind of document) yet neither a name nor an
// expiry date could be found anywhere in it — that combination means
// "we got essentially nothing usable" regardless of what the confidence
// number says. Independent of PHOTO_QUALITY_FLAGS on purpose: this can
// fire even on a photo the quality heuristics call "fine".
function hasInsufficientExtraction(flags) {
  return flags.includes('name_not_found') && (flags.includes('no_expiry_date_found') || flags.includes('no_issue_date_found'));
}

async function maybeCreateRecaptureTask({ candidateId, candidateName, requirementName, reasons, flags, checkedByEmail, checkedByName }) {
  const qualityFlagged = flags.some(f => PHOTO_QUALITY_FLAGS.has(f));
  const insufficientExtraction = hasInsufficientExtraction(flags);
  if (!candidateId || (!qualityFlagged && !insufficientExtraction)) return null;
  const db = getDb();

  // One open request per candidate+document at a time — a nightly sweep
  // re-checking the same still-uncorrected photo every night shouldn't
  // raise a fresh task every night; a marker in the description (not a
  // dedicated column — this is the one place that needs it) is enough to
  // find an existing open one without a schema change.
  const marker = `[[doc_recapture:${candidateId}:${requirementName}]]`;
  const existing = (await db.execute({
    sql: `SELECT id FROM tasks WHERE department_id = 'quality' AND status != 'done' AND description LIKE ? LIMIT 1`,
    args: [`%${marker}%`]
  })).rows[0];
  if (existing) return existing.id;

  const contact = (await db.execute({
    sql: 'SELECT contact_no, email FROM rt_candidates_cache WHERE user_id = ?',
    args: [candidateId]
  })).rows[0];
  // reasons/flags aren't reliably parallel arrays index-for-index across the
  // whole checker (a few checks push a reason with no matching flag or vice
  // versa — confirmed by counting both arrays' push() calls in
  // documentCheckerService.js: 37 vs 36), so matching by array position
  // would be a real, silent bug here. Matching on the literal quality-check
  // wording itself (a small, fixed set of templates from
  // applyPhotoQualityFlags, plus the name/date-not-found templates every
  // expiring-document checker shares) is exact regardless of ordering
  // elsewhere.
  const QUALITY_REASON_SUBSTRINGS = [
    'OCR could only read', 'Photo looks very dark', 'washed out/overexposed', 'Image resolution is very low', 'Photo looks blurry',
    'Could not extract a name', 'Could not find a clear expiry date', 'Could not find a clear issue date'
  ];
  const qualityReasons = reasons.filter(r => QUALITY_REASON_SUBSTRINGS.some(s => r.includes(s)));
  const name = candidateName || `Candidate #${candidateId}`;
  const openingLine = qualityFlagged
    ? `Automated Document Checker flag — this ${requirementName} photo couldn't be read reliably and needs a clearer re-upload.`
    : `Automated Document Checker flag — this ${requirementName} document reads as the right document type, but neither a name nor an expiry date could be found on it anywhere. That usually means the image is too small/cropped/low-quality to make out the printed details, even though the overall photo doesn't look obviously bad — a clearer re-upload would help confirm it.`;
  const description = [
    openingLine,
    ...qualityReasons,
    contact?.contact_no ? `Mobile: ${contact.contact_no}` : null,
    contact?.email ? `Email: ${contact.email}` : null,
    `RT profile: https://backoffice.rawtalent.com.au/#/candidateDetails?userID=${candidateId}`,
    marker
  ].filter(Boolean).join('\n');

  return createTask({
    departmentId: 'quality',
    title: `Ask ${name} to re-upload their ${requirementName} — photo unreadable`,
    description,
    priority: 'normal',
    linkedCandidates: [{ userId: candidateId, name, phone: contact?.contact_no || null }],
    createdByEmail: checkedByEmail,
    createdByName: checkedByName
  });
}

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

  // Fire-and-forget-adjacent, but awaited: cheap (one existence check, maybe
  // one insert), and a caller that returns before this runs would leave a
  // real quality flag silently un-actioned if the process happened to exit
  // right after responding. Never lets a task-creation failure fail the
  // check itself — the check already succeeded and is already saved above.
  let recaptureTaskId = null;
  try {
    recaptureTaskId = await maybeCreateRecaptureTask({
      candidateId, candidateName, requirementName, reasons: result.reasons, flags: result.flags,
      checkedByEmail, checkedByName: checkedByName || checkedByEmail
    });
  } catch (err) {
    console.error('Auto re-capture task creation error:', err.message);
  }

  return {
    id, extractionMethod: method, ocrConfidence: confidence, reviewed: false, recaptureTaskId,
    aiFallbackAvailable: aiFallback.isAiFallbackWorthwhile(result.extracted, result.flags),
    ...result
  };
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

// Explicit, per-document, human-clicked only — see
// services/documentCheckerAiFallbackService.js's own header for why this
// exists as a deliberate last resort rather than something the checker
// ever reaches for on its own. Never fired automatically from check-from-rt
// or the bulk sweep; the frontend only shows the "Run AI Check" button at
// all when the just-returned check itself said aiFallbackAvailable: true —
// this route re-validates that same condition server-side rather than
// trusting the client, so a stale/tampered request can't spend AI credit
// on a check that already has everything the deterministic pass needs.
router.post('/:id/ai-check', async (req, res) => {
  try {
    const row = (await getDb().execute({ sql: 'SELECT flags, extracted_fields FROM document_checks WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'Document check not found.' });
    if (!aiFallback.isAiFallbackWorthwhile(row.extracted_fields, row.flags)) {
      return res.status(409).json({ error: 'This check already has a name, date, and confirmed document type from the free deterministic pass — an AI second look isn\'t needed here.' });
    }
    const updated = await aiFallback.runAiFallbackForCheck(req.params.id, req.user.email);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
              review_notes, checked_by_email, checked_by_name, created_at, document_source_url,
              user_document_detail_id, ai_assist_used, ai_extracted_fields, ai_note, ai_requested_by, ai_requested_at
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
//
// Real bug (found 2026-09-09, accuracy-auditing against a real candidate):
// a candidate whose RT record is itself a superseded "_migration_delete"
// ghost profile (is_deleted=true — the exact same duplicate-profile pattern
// already fixed in services/taskPersonMatchService.js's match queries
// earlier this session, just never carried over here) was showing up in
// this list. A manager reviewing "who needs attention" has no use for a
// deleted, superseded RT record — it wastes their time and can't actually
// be acted on. Excludes any candidate whose current rt_candidates_cache row
// is_deleted, via a LEFT JOIN (LEFT, not INNER — a check on a candidate
// who's since dropped out of the cache entirely, e.g. never synced, must
// still show rather than silently vanishing just because the join found
// nothing).
router.get('/flagged', async (req, res) => {
  try {
    const result = await getDb().execute(`
      WITH latest AS (
        SELECT DISTINCT ON (candidate_id, user_document_detail_id) *
        FROM document_checks
        WHERE candidate_id IS NOT NULL
        ORDER BY candidate_id, user_document_detail_id, created_at DESC
      )
      SELECT l.candidate_id,
             (array_agg(l.candidate_name_input ORDER BY l.created_at DESC))[1] AS candidate_name,
             COUNT(*) AS flagged_count,
             array_agg(DISTINCT l.outcome) AS outcomes,
             array_agg(DISTINCT l.requirement_name ORDER BY l.requirement_name) AS flagged_documents,
             MAX(l.created_at) AS most_recent_at
      FROM latest l
      LEFT JOIN rt_candidates_cache c ON c.user_id = l.candidate_id
      WHERE l.outcome IN ('needs_review', 'invalid') AND l.reviewed = false
        AND (c.is_deleted IS NOT TRUE)
      GROUP BY l.candidate_id
      ORDER BY most_recent_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WWCC bulk-verification CSV export (2026-09-10) — researched live whether
// VIC/SA expose a public API for automated WWCC status cross-checking:
// neither does. Confirmed for SA via a real third-party verification-
// automation vendor's own documentation ("South Australia needs your
// organisation's DHS Screening Unit portal login... There's no anonymous
// route — the portal is the only way to check an SA clearance" — even a
// company whose entire business is automating this kind of check has no
// real API to call, only portal-login simulation). Confirmed for VIC by
// opening the real, live status-checker tool directly: no API, but it DOES
// offer an official bulk-CSV upload (up to 1500 at once, exactly 2
// columns: "family name" and "card number") — a genuine, sanctioned way to
// make the SOP's existing manual "verify through the state portal" step
// far less painful than one-by-one, even though it's still a human
// uploading a file and reading results back, not a live automated
// cross-check. This endpoint generates that exact CSV from whichever real
// WWCC registration numbers the checker has already extracted and
// confirmed the format of (see documentCheckerService.js's
// checkWwccNumberFormat) — nothing here is invented, only real captured
// numbers from real checks already on file.
router.get('/export-wwcc-csv', async (req, res) => {
  const state = (req.query.state || 'VIC').toUpperCase();
  try {
    const result = await getDb().execute({
      sql: `WITH latest AS (
              SELECT DISTINCT ON (candidate_id, user_document_detail_id) *
              FROM document_checks
              WHERE candidate_id IS NOT NULL AND document_type = 'wwcc'
              ORDER BY candidate_id, user_document_detail_id, created_at DESC
            )
            SELECT c.last_name, l.extracted_fields->>'wwccRegistrationNumber' AS card_number
            FROM latest l
            JOIN rt_candidates_cache c ON c.user_id = l.candidate_id
            WHERE l.extracted_fields->>'wwccRegistrationNumber' IS NOT NULL
              AND l.extracted_fields->>'stateUsed' = ?
              AND (c.is_deleted IS NOT TRUE)
            ORDER BY c.last_name`,
      args: [state]
    });
    // CSV-escape each field per RFC 4180 (wrap in quotes, double any
    // embedded quote) — a family name with a comma or quote in it would
    // otherwise silently corrupt the column alignment VIC's own bulk tool
    // expects.
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['family name', 'card number'], ...result.rows.map(r => [r.last_name, r.card_number])];
    const csv = rows.map(row => row.map(esc).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="wwcc-bulk-check-${state}.csv"`);
    res.send(csv);
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

// ── ACECQA live sync (2026-09-12) ────────────────────────────────────────
// Same fire-and-forget + poll pattern as /bulk-check above and RT's own
// Sync Now (routes/reports.js) — a real sync takes ~10-15s (a headless
// browser launch + click + CSV download + table refresh), long enough that
// the caller shouldn't sit on an open HTTP request waiting for it. Restricted
// to super_admin for the same reason as bulk-check: routine use doesn't need
// this, "I need this run right now" does.
const acecqaSync = require('../services/acecqaSyncService');

router.post('/acecqa/sync', requireSuperAdmin, async (req, res) => {
  try {
    const current = await acecqaSync.getSyncState();
    if (acecqaSync.isSyncRunning(current)) {
      return res.status(409).json({ error: `An ACECQA sync is already in progress (started ${current.started_at}).` });
    }
    acecqaSync.syncFromAcecqaLive(req.user.email).catch(err => console.error('Manual ACECQA sync error:', err.message));
    res.json({ started: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/acecqa/sync-status', async (req, res) => {
  try {
    const state = await acecqaSync.getSyncState();
    res.json(state ? { ...state, isRunning: acecqaSync.isSyncRunning(state) } : null);
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
// Exported for services/documentCheckerAiFallbackService.js's vision-based
// AI check (2026-09-12) — it needs the real source image/PDF bytes, not
// just the already-OCR'd text, so it re-fetches from the same RT S3 host
// allowlist this file already enforces rather than duplicating that logic.
module.exports.fetchRtDocument = fetchRtDocument;
