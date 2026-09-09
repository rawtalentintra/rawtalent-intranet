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
    const { stdout, execErr } = await new Promise((resolve) => {
      // 120s (was 60s) — Phase 3 (2026-09-09) adds rasterize-then-OCR for
      // scanned PDFs with no text layer, which can mean several pages of
      // Tesseract OCR back-to-back instead of one image; 60s was enough
      // margin for a single photo but not reliably enough for a multi-page
      // scan.
      execFile('node', [WORKER_PATH, tempPath, filename], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdoutData) => {
        resolve({ stdout: stdoutData, execErr: err });
      });
    });
    // Real bug (found 2026-09-09, stress-testing): the old logic only
    // trusted execErr when stdout was completely EMPTY — a timeout kill
    // that catches the worker mid-write (large output, right on the
    // boundary the earlier stdout-truncation fix addresses) can leave a
    // PARTIAL JSON fragment in the pipe, which used to get handed straight
    // to JSON.parse() and fail with a confusing "Unterminated string"
    // error, completely masking the real cause. Reproduced empirically:
    // a killed-by-timeout worker with partial output. Now JSON.parse is
    // always tried first (it's the source of truth whenever the worker
    // actually finished normally, timeout or not), and execErr is only
    // consulted as the fallback explanation when parsing genuinely fails.
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      if (execErr?.killed) throw new Error('Document extraction timed out — the file may be too large or complex to process.');
      if (execErr) throw new Error(`Document extraction failed unexpectedly (${execErr.signal || execErr.code || execErr.message}).`);
      throw new Error('Extraction worker produced no readable output.');
    }
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

// A training-completion certificate template ("Protecting Children —
// Mandatory Reporting...", real Department of Education-branded
// certificate, 2026-09-10) states the name only as "Awarded to\n<Name>\nFor
// successful completion of...", no label/colon at all. `\n?` between
// "Awarded to" and the name since pdf-parse sometimes collapses the
// linebreak and sometimes doesn't, depending on the exact PDF's internal
// text-run structure.
const AWARDED_TO_PATTERN = /awarded\s+to\s*:?\s*\n?\s*([A-Za-z][A-Za-z '\-]{2,60})\s*\n/i;

// A RAN (Responding to Risks of Harm, Abuse and Neglect) training
// certificate — real, Educators SA/Plink-issued, 2026-09-10 — states the
// name only as "<Name>\nhas completed\nFULL CERTIFICATION...", no
// label/colon and no "Awarded to" phrasing either.
const HAS_COMPLETED_PATTERN = /^\s*([A-Za-z][A-Za-z '\-]{2,60})\s*\n\s*has\s+completed\b/im;

// Qualification/Course of Study (2026-09-10) — sampled 8 real candidate
// certificates directly from rt_candidates_cache (not guessed). The
// dominant real template, 5 of 8 samples (Cert III/Diploma of Early
// Childhood Education and Care, issued by several different private RTOs —
// Partners in Training, CMC-Training At Work, New Futures Training, MCIE):
// "This is to certify that\n<Name>\nhas fulfilled the requirements for".
const FULFILLED_REQUIREMENTS_PATTERN = /this\s+is\s+to\s+certify\s+that\s*\n\s*([A-Za-z][A-Za-z '\-]{2,60})\s*\n\s*has\s+fulfilled/i;
// A second real template (Elite College Australia, CHC30113 Certificate
// III): "THIS CERTIFIES THAT\n<Name>\nhas successfully completed".
// [^\n]{0,10} tolerates OCR noise between the name and the line break (real
// sample: "Kowsar Mohamed Abshir :" — a stray colon the capture group's own
// character class deliberately excludes, so without this the match would
// silently fail right where the name ends).
const CERTIFIES_THAT_PATTERN = /this\s+certifies\s+that\s*\n\s*([A-Za-z][A-Za-z '\-]{2,60})[^\n]{0,10}\n\s*has\s+successfully\s+completed/i;
// A third real template ("Record of Results" from Sage Institute of
// Education, a scanned/OCR'd unit-by-unit transcript rather than a single
// certificate): "This is a record that\n<Name>\nhas attained". [^\n]{0,20}
// tolerates trailing junk before the line break — the one real sample of
// this template has a bracketed student ID right after the name
// ("Ritiya Nantib (25335)"), which without this addition made the whole
// pattern silently fail to match at all (found by actually running this
// checker against the real sample, not assumed). That real sample also has
// a misread surname ("Nantib" for a candidate on file as "McGlone") — a
// genuine OCR/scan-quality limitation no regex can fix; namesLikelyMatch
// will correctly flag it as a mismatch rather than silently accepting it.
const RECORD_THAT_PATTERN = /this\s+is\s+a\s+record\s+that\s*\n\s*([A-Za-z][A-Za-z '\-]{2,60})[^\n]{0,20}\n\s*has\s+attained/i;

// Best-effort name extraction — looks for a line right after a "Name:"/
// "Applicant:" label first (simpler certificate formats), then falls back
// to the ACIC "Subject Details" table, then the AFP "...name of:...born
// on" phrasing, then a training-certificate's "Awarded to" or "<Name> has
// completed" phrasing, then the three real Qualification-certificate
// templates above. Genuinely free-form across issuers, so this is a hint
// for the human reviewer, not something the outcome hinges on by itself —
// see namesLikelyMatch. (Two other real Qualification templates sampled —
// a university degree's "be it known that... having fulfilled all the
// requirements..." and a variant where the name prints BEFORE "This is to
// certify that" instead of after — aren't covered by any pattern here; a
// name-extraction miss on those is an honest gap, not a silent wrong
// answer, exactly like the existing WWCC name-extraction gap.)
function extractApplicantName(text) {
  const labelMatch = text.match(/(?:applicant|full\s+name|name)\s*:\s*([A-Za-z][A-Za-z '\-]{2,60})/i);
  if (labelMatch) return labelMatch[1].trim();
  const subjectMatch = text.match(SUBJECT_NAME_PATTERN);
  if (subjectMatch) return subjectMatch[1].trim().replace(/\s+/g, ' ');
  const nameOfMatch = text.match(NAME_OF_PATTERN);
  if (nameOfMatch) return nameOfMatch[1].trim().replace(/\s+/g, ' ');
  const awardedToMatch = text.match(AWARDED_TO_PATTERN);
  if (awardedToMatch) return awardedToMatch[1].trim().replace(/\s+/g, ' ');
  const hasCompletedMatch = text.match(HAS_COMPLETED_PATTERN);
  if (hasCompletedMatch) return hasCompletedMatch[1].trim().replace(/\s+/g, ' ');
  const fulfilledMatch = text.match(FULFILLED_REQUIREMENTS_PATTERN);
  if (fulfilledMatch) return fulfilledMatch[1].trim().replace(/\s+/g, ' ');
  const certifiesMatch = text.match(CERTIFIES_THAT_PATTERN);
  if (certifiesMatch) return certifiesMatch[1].trim().replace(/\s+/g, ' ');
  const recordMatch = text.match(RECORD_THAT_PATTERN);
  if (recordMatch) return recordMatch[1].trim().replace(/\s+/g, ' ');
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
// \bexpiry\b added 2026-09-10 — a real VIC digital WWCC printout (Service
// Victoria's own "Download your WWCC" PDF) prints the label as a bare
// "EXPIRY" directly followed by the date, no "date"/":"/"on" connecting
// word at all ("EXPIRY 05 OCT 2027"). Without it, this specific real
// document only got the right expiry by luck of the fallback (latest date
// on the page) rather than because the label was actually recognised —
// found while investigating why the field looked unconfirmed even though
// the outcome happened to be correct. Listed last in the alternation so
// the more specific patterns above it still win where they apply (regex
// alternation picks whichever alternative matches first in the list at a
// given position, and "expiry date"/"expiry:" etc. all start at the same
// position "expiry" alone would).
const EXPIRY_LABEL_PATTERN = /expiry\s*date|expir(?:y|es|ation)\s*:|expires\s*(on)?|valid\s*until|date\s+of\s+expiry|valid\s*to|\bexpiry\b/i;
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
// Real bug (found 2026-09-10, checking a real candidate's real documents):
// a genuine certificate ("Awarded to [name]... For successful completion
// of Protecting Children – Mandatory Reporting and Other Obligations...")
// was flagged as the WRONG document — traced to an EN DASH (– U+2013)
// between "Children" and "Mandatory", which this pattern's (-|—) only
// covered a plain hyphen and EM dash (—  U+2014) for, missing the
// character actually used. The exact same Unicode-punctuation-mismatch bug
// class as Phase 1's curly-apostrophe fix, just a dash instead of a quote.
const PROTECTING_CHILDREN_TRAINING_TYPE_PATTERN = /protecting\s+children\s*[-–—]?\s*mandatory\s+reporting|protecting\s+children\s+certificate/i;

// RAN (Responding to Risks of Harm, Abuse and Neglect) training —
// verified against 2 real Educators SA/Plink-issued certificates
// (2026-09-10). "RRHAN" is the training's own registration-number prefix
// (e.g. "RRHAN-22539092-24912286") — reliable and distinctive on its own,
// so it's included as an alternative to the full descriptive phrase in
// case OCR/formatting mangles the longer wording.
const RAN_TRAINING_TYPE_PATTERN = /\bRRHAN\b|responding\s+to\s+risks?\s+of\s+harm/i;

// Shared shape for any document type whose compliance_requirements row is
// keyed by (state, document_type) and whose validity is confirmed by one
// recognisable phrase somewhere in the document — WWCC-family cards, Blue
// Card, First Aid certificates, and the two training-completion types all
// fit this (only the expiry HANDLING differs, and that's driven entirely
// by the requirement row's own expiry_source, not by which type it is).
//
// `expectedIssuerPattern` (2026-09-10, grounded in Raw Talent's own real
// internal QA SOP — "SOP: Educator Profile Screening Process" — Step 7's
// checklist explicitly names the exact issuing college/authority to verify
// per document type: "College Name is entered as: Department of
// Education" for the Protecting Children Certificate, "GECCKO" for Child
// Safety Training) — optional; when given and NOT found in the text, adds
// a soft `unrecognised_issuer` flag, same severity as checkPoliceCheck's
// own issuing-authority check (needs_review, never forces invalid on its
// own — an OCR misread or a template variation shouldn't be treated the
// same as a confirmed wrong document).
function makeExpiringDocumentChecker(documentType, typePattern, wrongTypeMessage, expectedIssuerPattern = null) {
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

    if (expectedIssuerPattern && !expectedIssuerPattern.test(text)) {
      reasons.push(`Could not find the expected issuing college/authority in the document — check this is genuinely from the right provider.`);
      flags.push('unrecognised_issuer');
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

// ── WWCC registration-number format validation (2026-09-10) ─────────────
// Real internal QA SOP ("SOP: Educator Profile Screening Process") Step 7
// gives the exact expected registration-number format per state, since
// staff are told to enter it "using the correct format" when logging their
// manual portal verification:
//   Victoria (VIC): 1111111A-01  (7 digits, 1 letter, dash, 2 digits)
//   South Australia (SA): SRN1111-1111  (SRN, 4 digits, dash, 4 digits)
// NOT independently verified against a real production VIC/SA document,
// unlike most other patterns in this file — every real WWCC-labelled
// document currently on file in this dataset turned out to be WA's, and
// zero real SA-labelled ones have a file attached at all (checked
// directly, 2026-09-10). Built straight from the SOP's own literal stated
// examples instead, and flagged accordingly in its own reason text so a
// reviewer knows this specific check hasn't been confirmed against a real
// card yet. Only checked when the candidate's state IS VIC or SA (no
// format is stated for any other state) and only ever a soft,
// needs_review-level signal — an OCR misread or an unanticipated card
// layout variation shouldn't be treated as a confirmed problem.
const WWCC_NUMBER_PATTERNS = {
  VIC: { pattern: /\b\d{7}[A-Z]-\d{2}\b/i, example: '1111111A-01' },
  SA: { pattern: /\bSRN\d{4}-\d{4}\b/i, example: 'SRN1111-1111' }
};

// Returns the matched number (for capturing into extracted fields — see
// checkWwcc below, useful for e.g. exporting VIC's own official bulk
// verification CSV: service.vic.gov.au's real "Working with Children Check
// status checker" bulk tool takes exactly "family name" + "card number"
// columns, confirmed live 2026-09-10) or null if none found.
function checkWwccNumberFormat(text, state, flags, reasons) {
  const expected = WWCC_NUMBER_PATTERNS[state];
  if (!expected) return null; // no stated format for this state — nothing to check
  const match = text.match(expected.pattern);
  if (!match) {
    reasons.push(`Could not find a ${state}-format WWCC registration number on this document (expected like ${expected.example}, per Raw Talent's own internal QA SOP — not yet independently confirmed against a real ${state} card) — check manually.`);
    flags.push('wwcc_number_format_unconfirmed');
    return null;
  }
  return match[0].toUpperCase();
}

const _checkWwccBase = makeExpiringDocumentChecker('wwcc', WWCC_TYPE_PATTERN,
  'Could not find wording confirming this is a Working with Children Check / Protecting Children Certificate / Working with Vulnerable People registration — may be the wrong document.');

async function checkWwcc(text, options = {}) {
  const result = await _checkWwccBase(text, options);
  const registrationNumber = checkWwccNumberFormat(text, options.state, result.flags, result.reasons);
  result.extracted.wwccRegistrationNumber = registrationNumber;
  if (result.flags.includes('wwcc_number_format_unconfirmed') && result.outcome === 'valid') result.outcome = 'needs_review';
  return result;
}

const checkBlueCard = makeExpiringDocumentChecker('blue_card', BLUE_CARD_TYPE_PATTERN,
  'Could not find wording confirming this is a Blue Card — may be the wrong document.');
const checkFirstAid = makeExpiringDocumentChecker('first_aid', FIRST_AID_TYPE_PATTERN,
  'Could not find wording confirming this is a First Aid certificate — may be the wrong document.');

// makeExpiringDocumentChecker (above) already fully handles
// expiry_source='no_expiry' as one of its three branches, making it a
// strict superset of what a separate "no expiry ever" checker function
// would do — Child Safety Training and Protecting Children Training both
// used to go through a dedicated makeNoExpiryTrainingChecker, retired
// 2026-09-10 once Protecting Children Training turned out to need real
// expiry logic after all (see PCC's compliance_requirements row comment:
// a real certificate literally states "valid for 12 months from the date
// of completion", missed originally because the type-confirmation and the
// expiry-computation were built as two separate concerns and only the
// former was checked against the real document at the time). One shared
// function now covers all of police_check/wwcc/blue_card/first_aid/
// child_safety_training/protecting_children_training — whichever
// expiry_source a row is set to just works, no checker-code change needed
// if a type's real expiry rule changes later.
// No expected-issuer check on either of these, deliberately — the real
// internal QA SOP names an expected "College Name" for both ("GECCKO" for
// Child Safety Training, "Department of Education" for the Protecting
// Children Certificate), and both were tried and tested against real
// documents (2026-09-10) before being retracted:
//   - Child Safety Training: a genuine, valid Foundations certificate came
//     from "Adelaide Centre for Child Protection" (University of
//     Adelaide), not GECCKO.
//   - Protecting Children Certificate: sampled 5 more real certificates —
//     only 2 of 5 actually printed "Department of Education" anywhere; a
//     genuine, valid one (same real course, same "valid for 12 months"
//     wording confirming the expiry logic above generalises fine) simply
//     used an earlier template without that phrase at all.
// Real evidence both times that the SOP's "College Name" checklist item
// describes what a HUMAN enters into an RT data-entry field, not something
// guaranteed to appear verbatim on every real certificate template — an
// automated text-presence check on either would have produced a real,
// meaningful false-positive rate rather than catching genuine problems.
const checkChildSafetyTraining = makeExpiringDocumentChecker('child_safety_training', CHILD_SAFETY_TYPE_PATTERN,
  'Could not find wording confirming this is a Child Safety Training certificate — may be the wrong document.');
// Real, distinct sector check (2026-09-10) — the real "Compliance Documents
// – PCC" Article explicitly shows a "Not Acceptable" example captioned
// "because it's for School Based, not Childcare": the same "Protecting
// Children - Mandatory Reporting and Other Obligations" training exists in
// a School-sector version too, via the same government training portal
// (protectngstraining.education.vic.gov.au), and it is NOT the version Raw
// Talent requires — only the Early Childhood Services course is. Both real
// certificates already verified this session ("for the Early Childhood
// Sector") confirm this exact phrase is what the correct course prints;
// the wrong (School) variant's real wording isn't available to verify
// directly (only shown as a screenshot in the Article, not extractable
// text), so this only asserts the POSITIVE confirmation Raw Talent's own
// real documents already prove true, rather than guessing at the wrong
// variant's exact phrasing and risking a pattern that doesn't actually
// match it.
const EARLY_CHILDHOOD_SECTOR_PATTERN = /early\s+childhood/i;

const _checkProtectingChildrenTrainingBase = makeExpiringDocumentChecker('protecting_children_training', PROTECTING_CHILDREN_TRAINING_TYPE_PATTERN,
  'Could not find wording confirming this is a Protecting Children (Mandatory Reporting) training certificate — may be the wrong document.');

async function checkProtectingChildrenTraining(text, options = {}) {
  const result = await _checkProtectingChildrenTrainingBase(text, options);
  if (result.extracted.documentTypeConfirmed && !EARLY_CHILDHOOD_SECTOR_PATTERN.test(text)) {
    result.extracted.documentTypeConfirmed = false;
    result.flags.push('wrong_document_type');
    result.reasons.push('This looks like the "Protecting Children – Mandatory Reporting" training, but the Early Childhood Services sector wording isn\'t present — Raw Talent only accepts the Early Childhood Services version of this course, not the School-based one (per the real Compliance Documents – PCC Article). Check manually.');
    result.outcome = 'invalid';
  }
  return result;
}
// expiry_source='printed_on_document' (see compliance_requirements' own
// cr-all-ran-training row) — both real certificates checked print an
// explicit "Expiry date: 31 December 2027" directly, extractExpiryDate's
// existing "expiry date" label already catches it with no new pattern
// needed.
const checkRanTraining = makeExpiringDocumentChecker('ran_training', RAN_TRAINING_TYPE_PATTERN,
  'Could not find wording confirming this is a RAN (Responding to Risks of Harm, Abuse and Neglect) training certificate — may be the wrong document.');

// Qualification/Course of Study (2026-09-10) — expiry_source='no_expiry'
// (see cr-all-qualification's own compliance_requirements comment): every
// real candidate on file with this requirement has RT's own expiryDate set
// to the '9999-12-31' sentinel, confirmed by directly querying
// rt_candidates_cache — a childcare qualification, once obtained, doesn't
// expire the way a police check or WWCC does.
//
// Type pattern is a compound OR across every real phrasing found sampling
// 8 real candidate certificates directly (Sage Institute, MCIE, Partners in
// Training, CMC-Training At Work, Australian Catholic University, Elite
// College Australia, New Futures Training — genuinely different RTOs/
// universities, no single expected issuer the way Police Check has one
// named authority, so — same reasoning as Child Safety Training/PCC's
// retracted issuer checks — no expectedIssuerPattern here):
//   - "has fulfilled the requirements" — 5 of 8 real samples, the dominant
//     Cert III/Diploma template regardless of which RTO issued it.
//   - "has successfully completed ... requirements for the qualification"
//     — Elite College's real "THIS CERTIFIES THAT" template.
//   - "australian qualifications framework" — printed on 6 of 8 real
//     samples (every RTO-issued one; the one genuine exception in this
//     sample, a Bachelor of Education degree, is covered by "having
//     fulfilled all the requirements" below instead), a broad real safety
//     net independent of the certificate's exact wording style.
//   - "has attained" — the real "Record of Results" / "Statement of
//     Attainment" template (Sage Institute; also the unit-level pages
//     bundled into Maheen Hyder's real file alongside her actual Diploma).
//   - "having fulfilled all the requirements" — Australian Catholic
//     University's real Bachelor of Education degree parchment (a
//     genuinely valid Qualification/Course of Study document with no CHC
//     code and no AQF wording at all).
// [\s\S]{0,60} (not a plain .{0,60}) between "completed" and "requirements
// for the qualification" — Elite College's real OCR text wraps that gap
// across a line break with stray characters in between ("has successfully
// completed all a :\nrequirements for the qualification of"), and a plain
// `.` never matches a newline without the (unsupported-in-this-codebase)
// /s flag, which silently failed this exact real sample until caught here.
const QUALIFICATION_TYPE_PATTERN = /has\s+fulfilled\s+the\s+requirements|has\s+successfully\s+completed[\s\S]{0,60}requirements\s+for\s+the\s+qualification|australian\s+qualifications?\s+framework|has\s+attained|having\s+fulfilled\s+all\s+the\s+requirements/i;

const checkQualification = makeExpiringDocumentChecker('qualification', QUALIFICATION_TYPE_PATTERN,
  'Could not find wording confirming this is a qualification certificate, testamur, or statement of attainment — may be the wrong document.');

const CHECKERS = {
  police_check: checkPoliceCheck,
  wwcc: checkWwcc,
  blue_card: checkBlueCard,
  first_aid: checkFirstAid,
  child_safety_training: checkChildSafetyTraining,
  protecting_children_training: checkProtectingChildrenTraining,
  ran_training: checkRanTraining,
  qualification: checkQualification
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

// ── Phase 4 (2026-09-09) — tiered fake-document heuristics ───────────────
// Two other approaches were tried and REJECTED after testing against real
// documents, not shipped speculatively:
//   - Error Level Analysis (recompress + block-level difference variance,
//     the standard technique real forensic tools use) — tested against 20
//     real, presumably-genuine production documents. Block-variance ratios
//     ranged 1.18 to 24.69 with no separation between "normal" and
//     "suspicious" — a real Passport scan with nothing to suggest tampering
//     scored a 24.69, higher than plenty of others. Naive single-JPEG-pass
//     ELA is well known in the forensics literature to need a human
//     examining the actual difference image, not an automated threshold —
//     this real test confirmed that limitation rather than being able to
//     work around it, so it was not shipped.
//   - PDF ModDate-significantly-after-CreationDate as a tamper flag —
//     tested against 11 real Police Check PDFs' metadata. One (completely
//     legitimate) real document showed a ~4.5 month gap, produced by "Ruby
//     CombinePDF" — a normal PDF-merging library, not tampering. A generic
//     mod-date-gap flag would false-positive on that real, genuine
//     document, so it was not shipped either.
// What DID hold up against real data:
//   - Producer/Creator naming a raster IMAGE EDITOR (Photoshop, GIMP,
//     Canva, etc.) — zero of 11 real genuine Police Check PDFs' Producer
//     strings matched any of these (real ones were iTextSharp, Prince,
//     Skia/Chromium print-to-PDF, EO.Pdf, macOS Quartz, FPDF — all PDF-
//     generation libraries or browser print engines, never an image
//     editor). A government/verification-authority document that DOES show
//     one is a genuine anomaly worth a second look. Deliberately scoped to
//     only the document types that should always be system-generated by an
//     issuing authority (police_check/wwcc/blue_card) — a Qualification or
//     First Aid certificate is completely normally made by a training
//     provider in Word/Canva, so applying this there would be constant
//     false positives on totally ordinary documents.
//   - The exact same file (by content hash) turning up under two different
//     candidates — 100% deterministic, no threshold to get wrong. Applied
//     in routes/documentChecker.js (needs the raw file buffer + database
//     access to compare across candidates, neither of which this function
//     has) rather than here.
const RASTER_EDITOR_SIGNATURE_PATTERN = /photoshop|gimp|illustrator|paint\.net|snapseed|pixlr|canva|affinity\s+photo|corel/i;
const AUTHORITY_ISSUED_TYPES = new Set(['police_check', 'wwcc', 'blue_card']);

function applyDocumentIntegrityFlags(flags, reasons, { documentType, pdfMetadata } = {}) {
  if (!pdfMetadata || !AUTHORITY_ISSUED_TYPES.has(documentType)) return false;
  const signature = [pdfMetadata.producer, pdfMetadata.creator].filter(Boolean).join(' ');
  if (RASTER_EDITOR_SIGNATURE_PATTERN.test(signature)) {
    reasons.push(`This PDF's own metadata shows it was produced with image-editing software (${signature.trim()}), not generated by an issuing authority's system — worth a closer look at whether this is a genuine certificate.`);
    flags.push('editing_tool_signature');
    return true;
  }
  return false;
}

// Real finding (2026-09-09, auditing checker accuracy against a real
// candidate): a candidate's "Police Check" slot held a Cited.com.au
// payment RECEIPT for the police check ("TAX INVOICE... National Police
// CheckBT1704686133949$43.16... Total Paid: $43.16"), not the actual
// certificate — a real, plausibly common onboarding mistake (uploading
// proof of payment instead of the document itself). The overall outcome
// still correctly landed on 'invalid' (no issuing authority, no applicant
// name found), so nothing false-positived through as valid — but the
// REASONS given were misleading: "Issued 08/01/2024 — past our 365-day
// renewal policy" reads as "ask them to renew it", when the real problem
// is there's no certificate here at all, not that one expired. The generic
// keyword type-check even reported documentTypeConfirmed=true, since the
// receipt's own "National Police Check" line-item description happens to
// contain the exact same wording a real certificate uses.
// Requires at least 2 of these invoice-specific terms to co-occur,
// deliberately conservative — a genuine certificate mentioning a fee or
// payment once in passing shouldn't trip this; a real payment receipt
// reliably has several of these together.
const INVOICE_MARKERS = [/tax\s+invoice/i, /invoice\s*#/i, /total\s*\(excl\s*gst\)/i, /total\s+gst\b/i, /total\s+paid\b/i, /total\s+outstanding\b/i, /receipt\s+number/i];

function applyInvoiceReceiptFlag(flags, reasons, text) {
  if (INVOICE_MARKERS.filter(p => p.test(text)).length < 2) return false;
  reasons.push('This looks like a payment receipt/invoice for the document, not the actual certificate itself — the real compliance document still needs to be uploaded.');
  flags.push('looks_like_receipt_not_document');
  return true;
}

async function runCheck(documentType, text, options) {
  const checker = CHECKERS[documentType];
  if (!checker) throw new Error(`No checker implemented for document type "${documentType}" yet.`);
  const result = await checker(text, options);

  const qualityFlagged = applyPhotoQualityFlags(result.flags, result.reasons, options || {});
  const integrityFlagged = applyDocumentIntegrityFlags(result.flags, result.reasons, { documentType, ...(options || {}) });
  const receiptFlagged = applyInvoiceReceiptFlag(result.flags, result.reasons, text);
  // A quality/integrity concern can only ever pull a clean 'valid' down to
  // 'needs_review' — it never gets to upgrade an already-'invalid' result
  // (that's already the most severe outcome) and never silently produces a
  // false 'valid' on its own (there's always some other flag involved,
  // never wrong_document_type/expired triggering purely off one of these).
  // Fake-document signals in particular are deliberately never allowed to
  // auto-set 'invalid' on their own — only a human should make that call;
  // this system's job is surfacing it for review, not accusing anyone.
  // A payment receipt is the one exception that DOES force 'invalid'
  // outright rather than just 'needs_review' — unlike a fake-document
  // heuristic (uncertain, needs a human's judgment call), "this is
  // definitely not the certificate" is not actually ambiguous once at
  // least 2 real invoice markers co-occur.
  if (receiptFlagged) result.outcome = 'invalid';
  else if ((qualityFlagged || integrityFlagged) && result.outcome === 'valid') result.outcome = 'needs_review';
  result.extracted = { ...result.extracted, ocrConfidence: options?.confidence ?? null, imageQuality: options?.quality ?? null };
  return result;
}

module.exports = {
  extractText, runCheck, getComplianceRequirement, invalidateRequirementCache,
  checkPoliceCheck, checkWwcc, checkBlueCard, checkFirstAid, checkChildSafetyTraining, checkProtectingChildrenTraining, checkRanTraining, checkQualification
};
