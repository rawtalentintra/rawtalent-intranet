const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

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
      execFile('node', [WORKER_PATH, tempPath, filename], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
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

// ── Police Check rule set ──────────────────────────────────────────
// Derived from our own SOPs, not invented: "Compliance Documents – Police
// Check (VIC)" (National Police Check, name-based, issued by Victoria
// Police) and "VIT-Registered Teachers – WWCC & Police Check Requirements"
// ("Raw Talent requires all educators to provide a current National Police
// Check that is renewed annually" — the 12-month validity window below).
const POLICE_CHECK_VALIDITY_DAYS = 365;

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
  const birthLabelIndex = text.search(/birth\s*date/i);
  if (birthLabelIndex !== -1 && valid.length > 1) {
    let closestIdx = -1, closestDist = Infinity;
    valid.forEach((d, i) => {
      const dist = Math.abs(d.index - birthLabelIndex);
      if (dist < closestDist) { closestDist = dist; closestIdx = i; }
    });
    if (closestIdx !== -1 && closestDist < 60) valid = valid.filter((_, i) => i !== closestIdx);
  }
  if (!valid.length) return null;

  const labelIndex = text.search(/date\s+of\s+issue|issue\s+date|date\s+issued|certificate\s+date|issued\s*:|report\s+run\s+date/i);
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

// Best-effort name extraction — looks for a line right after a "Name:"/
// "Applicant:" label first (simpler certificate formats), then falls back
// to the ACIC "Subject Details" table (real National Police Certificates,
// which don't use a colon-labelled name at all). Genuinely free-form across
// issuers, so this is a hint for the human reviewer, not something the
// outcome hinges on by itself — see namesLikelyMatch.
function extractApplicantName(text) {
  const labelMatch = text.match(/(?:applicant|full\s+name|name)\s*:\s*([A-Za-z][A-Za-z '\-]{2,60})/i);
  if (labelMatch) return labelMatch[1].trim();
  const subjectMatch = text.match(SUBJECT_NAME_PATTERN);
  if (subjectMatch) return subjectMatch[1].trim().replace(/\s+/g, ' ');
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
// expired or wrong document type).
function checkPoliceCheck(text, { candidateName } = {}) {
  const reasons = [];
  const flags = [];

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
    expiryDate = new Date(issueDate.getTime() + POLICE_CHECK_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
    isExpired = expiryDate < new Date();
    if (isExpired) {
      reasons.push(`Issued ${issueDate.toLocaleDateString('en-AU', { timeZone: 'UTC' })} — past our 12-month renewal policy (expired ${expiryDate.toLocaleDateString('en-AU', { timeZone: 'UTC' })}).`);
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
      nameMatchesCandidate: nameMatch
    }
  };
}

const CHECKERS = { police_check: checkPoliceCheck };

function runCheck(documentType, text, options) {
  const checker = CHECKERS[documentType];
  if (!checker) throw new Error(`No checker implemented for document type "${documentType}" yet.`);
  return checker(text, options);
}

module.exports = { extractText, runCheck, checkPoliceCheck };
