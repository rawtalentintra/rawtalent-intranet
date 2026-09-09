const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { getDb } = require('../db/database');

// A PDF with a real text layer (e.g. the "issued digitally via secure email
// link" National Police Certificate our Police Check SOP describes) parses
// to real text almost instantly via pdf-parse — no OCR needed, no cost at
// all. Below this character count, pdf-parse most likely just picked up
// stray metadata from a scanned/image-only PDF, so raster OCR is needed
// instead. Scanned PDFs aren't rasterized in this version (that needs a
// native PDF-to-image renderer) — image uploads (jpg/png) go straight to
// OCR below. (Shared with documentExtractionWorker.js — kept here too since
// nothing else in this file needs it, and duplicating one constant is
// simpler than a shared-constants module for a single value.)
const WORKER_PATH = path.join(__dirname, 'documentExtractionWorker.js');

// Extraction runs in a disposable child process, one per file — NOT a
// simple in-process call to pdf-parse/tesseract.js. Found empirically:
// after any Tesseract OCR call, the next pdf-parse call in that same
// process either throws on a perfectly valid PDF, or resolves fine but
// leaves a stray background promise that rejects later as an *unhandled*
// rejection, which crashes the whole Node process by default (Node
// terminates on unhandled rejections). Isolating every extraction in its
// own process removes the shared state that corrupts, and contains any
// future crash from either library to a disposable child instead of the
// live API server. See documentExtractionWorker.js for the actual
// extraction logic.
async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  const tempPath = path.join(os.tmpdir(), `doc-check-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  await fs.writeFile(tempPath, buffer);
  try {
    const stdout = await new Promise((resolve, reject) => {
      // 120s (was 60s) — Phase 3 (2026-09-09) adds rasterize-then-OCR for
      // scanned PDFs with no text layer, which can mean several pages of
      // Tesseract OCR back-to-back instead of one image; 60s was enough
      // margin for a single photo but not reliably enough for a multi-page
      // scan.
      execFile('node', [WORKER_PATH, tempPath, filename], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve(stdout);
      });
    });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.result;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

// ── Compliance Requirements lookup (Phase 0, 2026-09-09) ────────────────
// Every checker below reads its validity period/expiry rule from
// compliance_requirements (db/schema.sql) instead of a hardcoded JS
// constant — a validity-period change is now a data edit through the
// Document Checker's own admin UI, not a code change. Cached briefly
// purely to avoid a DB round-trip on every single document check in a
// batch run (Phase 5); this table changes rarely enough that a short TTL
// costs nothing real in staleness.
const REQUIREMENT_CACHE_TTL_MS = 5 * 60 * 1000;
let requirementCache = { byKey: null, expiresAt: 0 };

async function getComplianceRequirement(documentType, state = 'ALL') {
  if (!requirementCache.byKey || Date.now() >= requirementCache.expiresAt) {
    const rows = (await getDb().execute('SELECT * FROM compliance_requirements')).rows;
    const byKey = new Map();
    for (const r of rows) byKey.set(`${r.state}:${r.document_type}`, r);
    requirementCache = { byKey, expiresAt: Date.now() + REQUIREMENT_CACHE_TTL_MS };
  }
  // A real state-specific row wins over the 'ALL' fallback when both exist
  // for the same document_type (not the case for police_check today, but
  // future document types like 'wwcc' are state-specific by design).
  return requirementCache.byKey.get(`${state}:${documentType}`) || requirementCache.byKey.get(`ALL:${documentType}`) || null;
}
// Exported so an admin edit to compliance_requirements (routes/
// documentChecker.js's PUT) can invalidate this immediately instead of
// waiting out the TTL — a validity-period change should apply to the very
// next check, not up to 5 minutes later.
function invalidateRequirementCache() { requirementCache = { byKey: null, expiresAt: 0 }; }

const DOCUMENT_TYPE_PATTERN = /national\s+police\s+(check|certificate)|nationally\s+coordinated\s+criminal\s+history\s+check|police\s+certificate|criminal\s+history\s+check/i;

// State/territory police services plus ACIC (Australian Criminal
// Intelligence Commission), the body actually accredited to issue National
// Police Checks — a genuine certificate names one of these somewhere.
const ISSUING_AUTHORITY_PATTERN = /victoria\s+police|nsw\s+police|new\s+south\s+wales\s+police|queensland\s+police|western\s+australia\s+police|wa\s+police|south\s+australia\s+police|sa\s+police|tasmania\s+police|northern\s+territory\s+police|act\s+policing|australian\s+federal\s+police|\bafp\b|australian\s+criminal\s+intelligence\s+commission|\bacic\b/i;

// Matches "12 Jan 2026", "12/01/2026", "12-01-2026", "January 12, 2026" —
// the range covers the formats we've actually seen on these certificates.
// The slash/hyphen alternatives each require a CONSISTENT separator (not a
// shared [/-] class matching either at each position) — found empirically
// against a real certificate: an address like "7/11-13 Sydney Street"
// (unit 7 of 11-13 Sydney Street) was matching as a date "7/11-13" →
// parsed as 7 Nov 2013, which then got treated as the certificate's issue
// date. Real dates never mix "/" and "-" within the same value; addresses
// with a unit-of-range format do, so requiring one consistent separator
// throughout rules out that whole class of false positive.
const DATE_PATTERN = /(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4})|(\d{1,2}\/\d{1,2}\/\d{2,4})|(\d{1,2}-\d{1,2}-\d{2,4})|((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})/gi;

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

// Always anchors to UTC midnight for the given calendar date, regardless of
// which format matched — these are all calendar dates off a printed
// certificate (no time-of-day involved), and every date comparison this
// service does (12-month expiry math, "is this in the past") is calendar-
// only. Building via `new Date(y, m, d)` (local time) and later reading it
// back with .toISOString() (UTC) would silently shift the displayed date
// by a day for anyone in a timezone ahead of UTC — worth avoiding entirely
// rather than chasing it later, since a reviewer trusting the wrong issue
// date is exactly the kind of mistake this feature exists to prevent.
function parseFlexibleDate(raw) {
  const cleaned = raw.replace(',', '').trim();

  // DD/MM/YYYY or DD-MM-YYYY (AU convention — day first) — same consistent-
  // separator requirement as DATE_PATTERN above, for the same reason.
  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/) || cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (slashMatch) {
    let [, d, m, y] = slashMatch;
    if (y.length === 2) y = `20${y}`;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return isNaN(date) ? null : date;
  }

  // "20 March 2026" or "March 20 2026"
  const monthNameMatch = cleaned.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i) || cleaned.match(/^([a-z]+)\s+(\d{1,2})\s+(\d{4})$/i);
  if (monthNameMatch) {
    const isDayFirst = /^\d/.test(monthNameMatch[1]);
    const day = Number(isDayFirst ? monthNameMatch[1] : monthNameMatch[2]);
    const monthName = (isDayFirst ? monthNameMatch[2] : monthNameMatch[1]).slice(0, 3).toLowerCase();
    const year = Number(monthNameMatch[3]);
    const monthIdx = MONTH_INDEX[monthName];
    if (monthIdx === undefined) return null;
    const date = new Date(Date.UTC(year, monthIdx, day));
    return isNaN(date) ? null : date;
  }

  return null;
}

// Pulls every date out of the text and returns the one nearest a
// recognised issue-date label if we can find one — "Report Run Date/Time"
// is the actual label real ACIC-template certificates use (verified
// against two real documents; there's no separate "Issue Date" field on
// that template at all), so it has to be treated as a real issue-date
// label, not just the generic English ones. Falls back to the earliest
// plausible date in the document only if no label matches at all.
function extractIssueDate(text) {
  const dates = [...text.matchAll(DATE_PATTERN)].map(m => ({ raw: m[0], parsed: parseFlexibleDate(m[0]), index: m.index }));
  let valid = dates.filter(d => d.parsed && d.parsed.getFullYear() > 2000 && d.parsed <= new Date());
  if (!valid.length) return null;

  // A candidate's birth date is always earlier than the certificate's real
  // issue date, so if it's left in the pool it wins the "earliest date"
  // fallback below on any format where the issue-date label isn't
  // recognised — verified against a real certificate where this produced a
  // false "expired" result off someone's date of birth. Drop whichever
  // date sits right next to a "Birth Date" label (a few characters away,
  // not just nearest across the whole document) before falling back.
  //
  // "born on" added (2026-09-09) after finding a real Digital National
  // Police Certificate — AFP's own template, distinct from the ACIC-branded
  // "Report Run Date"/"Name(s) Primary" template every other real
  // certificate seen so far uses — that phrases it as "MIOLE, Deniel Ann
  // born on 26 April 2003" with no "Birth Date" label at all. Without this,
  // the birth date won the earliest-date fallback and produced a false
  // "expired" result off a 2003 birth date instead of the real 2023 issue
  // date — exactly the same failure mode this exclusion already exists to
  // prevent, just from different real-world wording.
  const birthLabelIndex = text.search(/birth\s*date|\bborn\s+on\b/i);
  if (birthLabelIndex !== -1 && valid.length > 1) {
    let closestIdx = -1, closestDist = Infinity;
    valid.forEach((d, i) => {
      const dist = Math.abs(d.index - birthLabelIndex);
      if (dist < closestDist) { closestDist = dist; closestIdx = i; }
    });
    if (closestIdx !== -1 && closestDist < 60) valid = valid.filter((_, i) => i !== closestIdx);
  }
  if (!valid.length) return null;

  // "as at" added (2026-09-09) — the same real AFP "Digital National Police
  // Certificate" template above states its effective date only as "...as at
  // 23 December 2023", no "issue date"-style label anywhere on the page at
  // all. Note text.search() returns whichever alternative occurs EARLIEST
  // in the document, not whichever is listed first here — "as at" being
  // generic enough to theoretically appear elsewhere in a longer document
  // is an accepted, pre-existing trade-off shared by every other label in
  // this pattern (any of them could technically appear in unrelated text
  // too); it's still far more specific to a certificate's effective date
  // than the plain earliest-date fallback below.
  const labelIndex = text.search(/date\s+of\s+issue|issue\s+date|date\s+issued|certificate\s+date|issued\s*:|report\s+run\s+date|\bas\s+at\b/i);
  if (labelIndex !== -1) {
    const nearest = valid.reduce((best, d) => {
      const dist = Math.abs(d.index - labelIndex);
      return dist < best.dist ? { d, dist } : best;
    }, { d: valid[0], dist: Infinity }).d;
    return nearest.parsed;
  }
  return valid.sort((a, b) => a.parsed - b.parsed)[0].parsed;
}

// Real ACIC-format certificates — the standard results template every
// accredited provider (Cited, Fit2Work, NCC Screening, etc.) wraps around
// an ACIC search, not just one vendor — print the applicant's name in a
// "Subject Details" table as "Name(s) Primary SURNAME, GIVENNAME". pdf-parse
// collapses that table row with no whitespace between cells (verified
// against a real certificate: "Name(s)PrimaryMO, YONGXUE"), so this can't
// assume a space or colon after the label the way a simple "Name:" does.
const SUBJECT_NAME_PATTERN = /name\(s\)\s*primary\s*([a-z][a-z,'\-\s]{2,60}?)(?=additional\s+identifier|birth\s+date|birth\s+place|gender\s*:|address|$)/i;

// A second real AFP template — "Digital National Police Certificate"
// (2026-09-09, a genuinely different real document from the ACIC-branded
// one SUBJECT_NAME_PATTERN above targets) — states the name only as
// "...against the name of:\nSURNAME, Given Name born on DD Month YYYY".
// Neither a colon-labelled "Name:" field nor an ACIC "Subject Details"
// table exists on this template at all.
const NAME_OF_PATTERN = /name\s+of\s*:?\s*([a-z][a-z,'\-\s]{2,60}?)\s+born\s+on\b/i;

// Best-effort name extraction — looks for a line right after a "Name:"/
// "Applicant:" label first (simpler certificate formats), then falls back
// to the ACIC "Subject Details" table, then the AFP "...name of:...born
// on" phrasing. Genuinely free-form across issuers, so this is a hint for
// the human reviewer, not something the outcome hinges on by itself — see
// namesLikelyMatch.
function extractApplicantName(text) {
  const labelMatch = text.match(/(?:applicant|full\s+name|name)\s*:\s*([A-Za-z][A-Za-z '\-]{2,60})/i);
  if (labelMatch) return labelMatch[1].trim();
  const subjectMatch = text.match(SUBJECT_NAME_PATTERN);
  if (subjectMatch) return subjectMatch[1].trim().replace(/\s+/g, ' ');
  const nameOfMatch = text.match(NAME_OF_PATTERN);
  if (nameOfMatch) return nameOfMatch[1].trim().replace(/\s+/g, ' ');
  return null;
}

// Cheap, dependency-free name comparison — normalizes case/whitespace and
// checks token overlap, not a full fuzzy-match library (this runs once per
// check, not across a whole table, so pg_trgm-style similarity is overkill
// here).
function namesLikelyMatch(a, b) {
  if (!a || !b) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const tokensA = new Set(norm(a));
  const tokensB = norm(b);
  const overlap = tokensB.filter(t => tokensA.has(t)).length;
  return overlap >= Math.min(2, tokensB.length);
}

// Runs the whole deterministic check — no AI call. Returns an outcome of
// 'valid' (passed every check), 'needs_review' (something's inconclusive —
// a human should look), or 'invalid' (a check actively failed, e.g.
// expired or wrong document type). `state` is the candidate's own state,
// threaded through even though Police Check's requirement row is 'ALL'
// (state-independent) — every other checker built on this same pattern
// (WWCC, Blue Card, ...) will be genuinely state-specific.
async function checkPoliceCheck(text, { candidateName, state } = {}) {
  const reasons = [];
  const flags = [];

  const requirement = await getComplianceRequirement('police_check', state);
  // No row at all would mean the Phase 0 seed got deleted — fall back to
  // the policy's own known value rather than crashing, but flag it loudly
  // since silently guessing a validity period is exactly what this table
  // exists to prevent.
  const validityDays = requirement?.validity_days ?? 365;
  if (!requirement) {
    reasons.push('No compliance_requirements row found for Police Check — used the 365-day fallback. Check the Compliance Rules table.');
    flags.push('requirement_row_missing');
  } else if (!requirement.verified) {
    reasons.push(`This document type's validity period is still an unverified draft in Compliance Rules (${requirement.source_note || 'no source noted'}) — confirm it before trusting the expiry below.`);
    flags.push('requirement_unverified');
  }

  const isRightDocType = DOCUMENT_TYPE_PATTERN.test(text);
  if (!isRightDocType) {
    reasons.push('Could not find wording confirming this is a National Police Check / Criminal History Check — may be the wrong document.');
    flags.push('wrong_document_type');
  }

  const authorityMatch = text.match(ISSUING_AUTHORITY_PATTERN);
  if (!authorityMatch) {
    reasons.push('No recognised issuing authority (state police service or ACIC) found in the text.');
    flags.push('unrecognised_issuer');
  }

  const issueDate = extractIssueDate(text);
  let expiryDate = null;
  let isExpired = null;
  if (issueDate) {
    expiryDate = new Date(issueDate.getTime() + validityDays * 24 * 60 * 60 * 1000);
    isExpired = expiryDate < new Date();
    if (isExpired) {
      reasons.push(`Issued ${issueDate.toLocaleDateString('en-AU', { timeZone: 'UTC' })} — past our ${validityDays}-day renewal policy (expired ${expiryDate.toLocaleDateString('en-AU', { timeZone: 'UTC' })}).`);
      flags.push('expired');
    }
  } else {
    reasons.push('Could not find a clear issue date in the document — check manually.');
    flags.push('no_issue_date_found');
  }

  const extractedName = extractApplicantName(text);
  const nameMatch = candidateName ? namesLikelyMatch(candidateName, extractedName) : null;
  if (candidateName && extractedName && nameMatch === false) {
    reasons.push(`Extracted name "${extractedName}" doesn't obviously match the candidate name provided ("${candidateName}") — check manually.`);
    flags.push('name_mismatch');
  } else if (candidateName && !extractedName) {
    reasons.push('Could not extract a name from the document to compare against the candidate.');
    flags.push('name_not_found');
  }

  // A document whose only issue is an unverified compliance rule still
  // can't honestly be called 'valid' — the expiry it was just checked
  // against might itself be wrong, so it goes to needs_review same as
  // every other inconclusive case, not a silent pass.
  let outcome;
  if (flags.includes('wrong_document_type') || flags.includes('expired')) {
    outcome = 'invalid';
  } else if (flags.length > 0) {
    outcome = 'needs_review';
  } else {
    outcome = 'valid';
  }

  return {
    outcome,
    reasons,
    flags,
    extracted: {
      documentTypeConfirmed: isRightDocType,
      issuingAuthority: authorityMatch ? authorityMatch[0] : null,
      issueDate: issueDate ? issueDate.toISOString().slice(0, 10) : null,
      expiryDate: expiryDate ? expiryDate.toISOString().slice(0, 10) : null,
      applicantName: extractedName,
      nameMatchesCandidate: nameMatch,
      validityDaysUsed: validityDays,
      requirementVerified: requirement?.verified ?? null
    }
  };
}

// ── Phase 1 (2026-09-09) — WWCC-family, Blue Card, First Aid, Child Safety
// Training ────────────────────────────────────────────────────────────
// Type-mapping (routes/documentChecker.js's REQUIREMENT_NAME_TO_TYPE) is
// grounded in a live query against real production rt_candidates_cache.raw
// ->'attachedRequirements' — 19 distinct real RT requirementName strings —
// rather than guessed labels. Several different RT label strings (per-state
// naming: "Protecting Children Certificate (VIC Only)", "Blue Card",
// "Registration to Work with Vulnerable People", the generic "Working with
// Children's Check (WwCC)", ...) all funnel into the small set of internal
// document_type keys below. Which STATE's compliance_requirements row
// applies is never inferred from which RT label was used — it always comes
// from the candidate's own actual state (threaded through as `state`,
// resolved from their real address), the same way checkPoliceCheck already
// works. That keeps this correct even though RT itself isn't consistent
// about naming every state's card differently.

// Extracts a printed expiry date the same way extractIssueDate (above) finds
// an issue date — looks for a recognised expiry label first. Falls back to
// the LATEST plausible date in the document when no label matches, the
// mirror image of extractIssueDate's earliest-date fallback: on a WWCC-style
// card with no recognised label, the expiry is the last date printed, an
// issue/application date is the first.
const EXPIRY_LABEL_PATTERN = /expiry\s*date|expir(?:y|es|ation)\s*:|expires\s*(on)?|valid\s*until|date\s+of\s+expiry|valid\s*to/i;
function extractExpiryDate(text) {
  const dates = [...text.matchAll(DATE_PATTERN)].map(m => ({ raw: m[0], parsed: parseFlexibleDate(m[0]), index: m.index }));
  const valid = dates.filter(d => d.parsed && d.parsed.getFullYear() > 2000);
  if (!valid.length) return null;

  const labelIndex = text.search(EXPIRY_LABEL_PATTERN);
  if (labelIndex !== -1) {
    const nearest = valid.reduce((best, d) => {
      const dist = Math.abs(d.index - labelIndex);
      return dist < best.dist ? { d, dist } : best;
    }, { d: valid[0], dist: Infinity }).d;
    return nearest.parsed;
  }
  return valid.sort((a, b) => b.parsed - a.parsed)[0].parsed;
}

// Doc-type confirmation patterns — deliberately broad enough to catch every
// real RT label for the type (see the Phase 1 comment above) without being
// so broad they'd match an unrelated document.
// work(ing) both accepted — RT's own real label "Registration to Work with
// Vulnerable People" (docId=57) uses the bare verb, not "Working", unlike
// every other real WWCC-family label seen; a document echoing its own
// requirement's exact wording needs to match both forms.
const WWCC_TYPE_PATTERN = /work(ing)?\s+with\s+(children|vulnerable\s+people)('?s)?\s*(check|card|clearance|registration)?|ochre\s+card|wwcc|wwvp/i;
// Verified against a real QLD Blue Card (2026-09-09, OCR confidence only 31
// on that particular scan — heavy security-watermark background — but this
// phrase still came through clearly): the card's own printed/watermark text
// says "WORKING WITH CHILDREN CARD", not the words "Blue Card" anywhere —
// "Blue Card" is only the scheme's brand name, never what's actually printed
// on the card itself. Matching on "blue card" alone (the first, unverified
// assumption) would have flagged every real Blue Card as the wrong document.
const BLUE_CARD_TYPE_PATTERN = /blue\s*card|working\s+with\s+children\s+card/i;
const FIRST_AID_TYPE_PATTERN = /first\s+aid|hltaid0\d\d|cardiopulmonary\s+resuscitation|\bcpr\b/i;
const CHILD_SAFETY_TYPE_PATTERN = /child\s*safe(ty)?\s*(standards?|training)?|foundations?\s+of\s+child\s+safety|advanced\s+child\s+safety/i;
// Verified against a real "Protecting Children Certificate (VIC Only)"
// file (2026-09-09) — see schema.sql's cr-vic-protecting-children-training
// comment for why this is its own type rather than folded into 'wwcc'.
const PROTECTING_CHILDREN_TRAINING_TYPE_PATTERN = /protecting\s+children\s*(-|—)?\s*mandatory\s+reporting|protecting\s+children\s+certificate/i;

// Shared shape for any document type whose compliance_requirements row is
// keyed by (state, document_type) and whose validity is confirmed by one
// recognisable phrase somewhere in the document — WWCC-family cards, Blue
// Card, and First Aid certificates all fit this (only the expiry HANDLING
// differs between them, and that's driven entirely by the requirement row's
// own expiry_source, not by which of these three it is). Child Safety
// Training doesn't fit this shape (no_expiry, never has a date to check at
// all) — see checkChildSafetyTraining below instead.
function makeExpiringDocumentChecker(documentType, typePattern, wrongTypeMessage) {
  return async function check(text, { candidateName, state } = {}) {
    const reasons = [];
    const flags = [];

    const requirement = await getComplianceRequirement(documentType, state);
    if (!requirement) {
      reasons.push(`No compliance_requirements row found for this document type${state ? ` in ${state}` : ''} — add one in Compliance Rules before this can be checked properly.`);
      flags.push('requirement_row_missing');
    } else if (!requirement.verified) {
      reasons.push(`This document type's rule is still an unverified draft in Compliance Rules (${requirement.source_note || 'no source noted'}) — confirm it before trusting the result below.`);
      flags.push('requirement_unverified');
    }

    const isRightDocType = typePattern.test(text);
    if (!isRightDocType) {
      reasons.push(wrongTypeMessage);
      flags.push('wrong_document_type');
    }

    // Expiry handling branches on the requirement row's own expiry_source —
    // 'printed_on_document' is the default assumption for this whole family
    // (every real WWCC/Blue Card/First Aid seed row uses it today) since
    // that's how these documents actually work: the card/certificate itself
    // states its own expiry, there's no separate "issue date + N days" math
    // to do. 'computed' stays supported for a future row (e.g. a state that
    // genuinely works like Police Check) without needing new checker code.
    const expirySource = requirement?.expiry_source || 'printed_on_document';
    let issueDate = null, expiryDate = null, isExpired = null;

    if (expirySource === 'no_expiry') {
      // Nothing to extract — this requirement type has no expiry at all.
    } else if (expirySource === 'computed') {
      issueDate = extractIssueDate(text);
      const validityDays = requirement?.validity_days ?? null;
      if (issueDate && validityDays) {
        expiryDate = new Date(issueDate.getTime() + validityDays * 24 * 60 * 60 * 1000);
      } else if (!issueDate) {
        reasons.push('Could not find a clear issue date in the document — check manually.');
        flags.push('no_issue_date_found');
      } else if (!validityDays) {
        reasons.push('This requirement is marked as computed from an issue date, but has no validity_days set in Compliance Rules.');
        flags.push('requirement_row_missing');
      }
    } else {
      expiryDate = extractExpiryDate(text);
      if (!expiryDate) {
        reasons.push('Could not find a clear expiry date printed on the document — check manually.');
        flags.push('no_expiry_date_found');
      }
    }

    if (expiryDate) {
      isExpired = expiryDate < new Date();
      if (isExpired) {
        reasons.push(`Expired ${expiryDate.toLocaleDateString('en-AU', { timeZone: 'UTC' })}.`);
        flags.push('expired');
      }
    }

    const extractedName = extractApplicantName(text);
    const nameMatch = candidateName ? namesLikelyMatch(candidateName, extractedName) : null;
    if (candidateName && extractedName && nameMatch === false) {
      reasons.push(`Extracted name "${extractedName}" doesn't obviously match the candidate name provided ("${candidateName}") — check manually.`);
      flags.push('name_mismatch');
    } else if (candidateName && !extractedName) {
      reasons.push('Could not extract a name from the document to compare against the candidate.');
      flags.push('name_not_found');
    }

    let outcome;
    if (flags.includes('wrong_document_type') || flags.includes('expired')) {
      outcome = 'invalid';
    } else if (flags.length > 0) {
      outcome = 'needs_review';
    } else {
      outcome = 'valid';
    }

    return {
      outcome,
      reasons,
      flags,
      extracted: {
        documentTypeConfirmed: isRightDocType,
        issueDate: issueDate ? issueDate.toISOString().slice(0, 10) : null,
        expiryDate: expiryDate ? expiryDate.toISOString().slice(0, 10) : null,
        applicantName: extractedName,
        nameMatchesCandidate: nameMatch,
        expirySourceUsed: expirySource,
        validityDaysUsed: requirement?.validity_days ?? null,
        requirementVerified: requirement?.verified ?? null,
        stateUsed: state || null
      }
    };
  };
}

const checkWwcc = makeExpiringDocumentChecker('wwcc', WWCC_TYPE_PATTERN,
  'Could not find wording confirming this is a Working with Children Check / Protecting Children Certificate / Working with Vulnerable People registration — may be the wrong document.');
const checkBlueCard = makeExpiringDocumentChecker('blue_card', BLUE_CARD_TYPE_PATTERN,
  'Could not find wording confirming this is a Blue Card — may be the wrong document.');
const checkFirstAid = makeExpiringDocumentChecker('first_aid', FIRST_AID_TYPE_PATTERN,
  'Could not find wording confirming this is a First Aid certificate — may be the wrong document.');

// Shared shape for a document type that never has an expiry to check at all
// (Child Safety Training and the VIC Protecting Children training
// certificate both confirmed 'no_expiry' against real documents) — just
// doc-type confirmation, the requirement-row verified check, and a name
// match, same as makeExpiringDocumentChecker minus everything date-related.
function makeNoExpiryTrainingChecker(documentType, typePattern, wrongTypeMessage) {
  return async function check(text, { candidateName, state } = {}) {
    const reasons = [];
    const flags = [];

    const requirement = await getComplianceRequirement(documentType, state);
    if (!requirement) {
      reasons.push(`No compliance_requirements row found for this document type${state ? ` in ${state}` : ''} — add one in Compliance Rules before this can be checked properly.`);
      flags.push('requirement_row_missing');
    } else if (!requirement.verified) {
      reasons.push(`This document type's rule is still an unverified draft in Compliance Rules (${requirement.source_note || 'no source noted'}) — confirm it before trusting the result below.`);
      flags.push('requirement_unverified');
    }

    const isRightDocType = typePattern.test(text);
    if (!isRightDocType) {
      reasons.push(wrongTypeMessage);
      flags.push('wrong_document_type');
    }

    const extractedName = extractApplicantName(text);
    const nameMatch = candidateName ? namesLikelyMatch(candidateName, extractedName) : null;
    if (candidateName && extractedName && nameMatch === false) {
      reasons.push(`Extracted name "${extractedName}" doesn't obviously match the candidate name provided ("${candidateName}") — check manually.`);
      flags.push('name_mismatch');
    } else if (candidateName && !extractedName) {
      reasons.push('Could not extract a name from the document to compare against the candidate.');
      flags.push('name_not_found');
    }

    let outcome;
    if (flags.includes('wrong_document_type')) {
      outcome = 'invalid';
    } else if (flags.length > 0) {
      outcome = 'needs_review';
    } else {
      outcome = 'valid';
    }

    return {
      outcome,
      reasons,
      flags,
      extracted: {
        documentTypeConfirmed: isRightDocType,
        applicantName: extractedName,
        nameMatchesCandidate: nameMatch,
        requirementVerified: requirement?.verified ?? null,
        stateUsed: state || null
      }
    };
  };
}

const checkChildSafetyTraining = makeNoExpiryTrainingChecker('child_safety_training', CHILD_SAFETY_TYPE_PATTERN,
  'Could not find wording confirming this is a Child Safety Training certificate — may be the wrong document.');
const checkProtectingChildrenTraining = makeNoExpiryTrainingChecker('protecting_children_training', PROTECTING_CHILDREN_TRAINING_TYPE_PATTERN,
  'Could not find wording confirming this is a Protecting Children (Mandatory Reporting) training certificate — may be the wrong document.');

const CHECKERS = {
  police_check: checkPoliceCheck,
  wwcc: checkWwcc,
  blue_card: checkBlueCard,
  first_aid: checkFirstAid,
  child_safety_training: checkChildSafetyTraining,
  protecting_children_training: checkProtectingChildrenTraining
};

// ── Phase 2 (2026-09-09) — non-AI photo-quality checks ──────────────────
// Applied centrally here (once, after whichever type-specific checker ran)
// rather than duplicated inside every checker above — quality is a property
// of the PHOTO, not of the document type, so it's the same test regardless
// of whether it's a Police Check or a Blue Card.
//
// Thresholds below were calibrated against ~60 real production documents
// (2026-09-09), not chosen abstractly — see the actual distribution this
// produced (after fixing a real bug the same pass turned up: a handful of
// uploads are 16-bit PNGs — iOS screenshots — whose raw brightness/blur
// numbers came back on a 0-65535 scale instead of 0-255 until
// documentExtractionWorker.js started normalizing through 8-bit JPEG first):
//   - OCR confidence ranged ~25-83 on real (legitimately genuine, just
//     phone-photographed) documents. Tesseract's own confidence score IS
//     already a direct, well-understood measure of "how legible was this
//     text" — the single most reliable signal here, and free (already
//     computed for every image check). <45 was where real documents in the
//     sample started being ones a human actually would want to double-check.
//   - Laplacian-variance blur score turned out NOT to have a single
//     universal "sharp" cutoff that works across document types — a
//     plain-text certificate naturally produces far less edge variance than
//     a busy ID-card photo even when both are perfectly in focus (confirmed
//     empirically: a clean, well-read First Aid certificate scored LOWER on
//     this metric than a blurry-looking WWCC photo that still had decent
//     OCR confidence).
//   - Resolution has the same problem in miniature: a real 606×428 document
//     read at 88% confidence and a real 1340×280 crop read at 94% — both
//     well under a naive "too small" cutoff, but neither was actually a
//     problem. A small image that OCR'd fine is not something to flag.
//   - Brightness has a real ceiling problem too: real, perfectly legible
//     documents reached up to 246/255 (most compliance documents ARE white
//     paper, so a high average brightness is the NORMAL case, not a red
//     flag) — a ceiling anywhere near that would misfire on ordinary scans
//     constantly. Only near-total whiteout is worth flagging.
// Net result: OCR confidence and brightness extremes are the only signals
// trustworthy enough to flag on their own; resolution and blur are only
// used as SUPPORTING context alongside an already-poor OCR read, never as
// an independent trigger — a small or lower-edge-variance image that still
// read fine is not a quality problem.
const MIN_OCR_CONFIDENCE = 45;
const MIN_BLUR_VARIANCE = 400; // supporting signal only — see comment above
const MIN_BRIGHTNESS = 20;
const MAX_BRIGHTNESS = 253;
const MIN_RESOLUTION_PX = 380; // shorter side — supporting signal only, see comment above

// Mutates flags/reasons in place and returns whether anything was flagged —
// called once per check, after the type-specific checker has already run,
// so its own flags/reasons are added alongside rather than replacing them.
function applyPhotoQualityFlags(flags, reasons, { confidence, quality } = {}) {
  let flagged = false;
  const lowConfidence = typeof confidence === 'number' && confidence < MIN_OCR_CONFIDENCE;
  if (lowConfidence) {
    reasons.push(`OCR could only read this document with ${confidence}% confidence — the photo may be blurry, poorly lit, or at an angle. Check the original manually.`);
    flags.push('low_ocr_confidence');
    flagged = true;
  }
  if (quality) {
    if (typeof quality.brightness === 'number' && quality.brightness < MIN_BRIGHTNESS) {
      reasons.push('Photo looks very dark — check it isn\'t underexposed or has something covering part of it.');
      flags.push('too_dark');
      flagged = true;
    } else if (typeof quality.brightness === 'number' && quality.brightness > MAX_BRIGHTNESS) {
      reasons.push('Photo looks washed out/overexposed — check for glare or flash reflection over the document.');
      flags.push('too_bright');
      flagged = true;
    }
    // Both gated on low OCR confidence too — see the threshold comment
    // above for why resolution/blur alone aren't trustworthy predictors of
    // an actual problem across different document types/crops.
    if (lowConfidence) {
      const shortSide = Math.min(quality.width || 0, quality.height || 0);
      if (shortSide && shortSide < MIN_RESOLUTION_PX) {
        reasons.push(`Image resolution is very low (${quality.width}×${quality.height}px) — likely contributing to the poor OCR read above.`);
        flags.push('low_resolution');
        flagged = true;
      }
      if (typeof quality.blurVariance === 'number' && quality.blurVariance < MIN_BLUR_VARIANCE) {
        reasons.push('Photo looks blurry (low image sharpness) — likely contributing to the poor OCR read above.');
        flags.push('blurry_image');
        flagged = true;
      }
    }
  }
  return flagged;
}

async function runCheck(documentType, text, options) {
  const checker = CHECKERS[documentType];
  if (!checker) throw new Error(`No checker implemented for document type "${documentType}" yet.`);
  const result = await checker(text, options);

  const qualityFlagged = applyPhotoQualityFlags(result.flags, result.reasons, options || {});
  // A quality problem can only ever pull a clean 'valid' down to
  // 'needs_review' — it never gets to upgrade an already-'invalid' result
  // (that's already the most severe outcome) and never silently produces a
  // false 'valid' on its own (there's always some other flag involved,
  // never wrong_document_type/expired triggering purely off a quality
  // issue).
  if (qualityFlagged && result.outcome === 'valid') result.outcome = 'needs_review';
  result.extracted = { ...result.extracted, ocrConfidence: options?.confidence ?? null, imageQuality: options?.quality ?? null };
  return result;
}

module.exports = {
  extractText, runCheck, getComplianceRequirement, invalidateRequirementCache,
  checkPoliceCheck, checkWwcc, checkBlueCard, checkFirstAid, checkChildSafetyTraining, checkProtectingChildrenTraining
};
