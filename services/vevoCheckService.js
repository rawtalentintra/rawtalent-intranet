const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

// ── VEVO check automation (2026-09-12) ────────────────────────────────
// Automates the exact real, manual process the "Compliance Documents –
// Visa (VEVO Check)" Article already documents step-by-step — the public
// "Visa Entitlement Verification Online: Visa holder enquiry" form at
// online.immi.gov.au/evo/firstParty. No API, no login: a real, publicly
// reachable government form, mapped field-for-field against the live site
// (2026-09-12) rather than guessed from the Article text alone.
//
// Real, deliberate compliance caveat (Joy, 2026-09-12): this specific
// form's own Terms and Conditions state, twice, that it's "only" for
// making inquiries about "your own immigration status" — built for a visa
// holder to self-check, not for a third party (an employer) checking on
// their behalf. The properly sanctioned path for an employer is
// registering RT as an organisation for VEVO via ImmiAccount (free,
// ABN-based, "Work entitlements" category) — flagged clearly to Joy, who
// chose to keep using this individual tool for now rather than set up
// organisation access first. This automates RT's existing real process
// exactly as already documented and already in use, nothing more.
//
// Real, confirmed (live, 2026-09-12) field structure — NOT guessed from
// the Article's own paraphrased steps, which turned out to describe one
// FEWER field than the real form actually has:
//   1. Document type: select — "Passport" or "ImmiCard" (only two RT's
//      own Article says are ever actually encountered)
//   2. Reference type: select — "Transaction Reference Number (TRN)" /
//      "Visa Evidence Number" / "Visa Grant Number" (never "Password" —
//      the Article's own SOP explicitly says "We can't use this option")
//   3. Date of birth: text field with a calendar picker
//   4. Document number: ONE text field, overloaded — despite the
//      Article's own wording ("Add Document Number (or Passport
//      Number)") reading like a distinct second field alongside the
//      reference type, the real form has only ONE number-entry field
//      total. What actually goes into it is whichever number matches
//      the Reference Type selected above (the TRN/Visa Evidence/Visa
//      Grant Number itself) — confirmed by inspecting the real live
//      form's full field set directly, not by re-reading the Article
//      text more carefully.
//   5. Country of document: select (matched by visible option label,
//      e.g. "INDONESIA" — Playwright's own label-matching handles the
//      exact value code, no need to hardcode all ~240 options here)
//   6. A "I have read and agree to the terms and conditions" checkbox
//      (required to submit at all)
//
// The RESULTS page's exact structure is NOT yet confirmed against a real
// submission — deliberately never tested with fabricated data against a
// live Commonwealth identity-verification system (see this file's own
// compliance caveat above; testing with made-up details would itself be
// a misuse of the service). parseResultText below is therefore a
// best-effort label-based extraction built from the exact field names
// RT's own Article says the results page shows ("Visa class and
// subclass", "grant date and expiry date", "Work rights", "Study
// rights", "Travel conditions", "special conditions") — the FULL raw
// page text is always stored alongside it (vevo_checks.raw_result_text)
// specifically so the very first real run can be used to correct any
// wording mismatch here without losing anything in the meantime.
const VEVO_URL = 'https://online.immi.gov.au/evo/firstParty?actionType=query';

const DOCUMENT_TYPE_LABELS = { passport: 'Passport', immicard: 'ImmiCard' };
const REFERENCE_TYPE_LABELS = {
  trn: 'Transaction Reference Number (TRN)',
  visa_evidence_number: 'Visa Evidence Number',
  visa_grant_number: 'Visa Grant Number'
};

// DD/MM/YYYY — the standard Australian date convention, matching every
// other AU-government-facing date field already in this codebase (e.g.
// WWCC card dates). NOT yet independently confirmed against this exact
// field on a real submission (same honesty as WWCC_NUMBER_PATTERNS' own
// comment in documentCheckerService.js) — if the real form expects a
// different format, this is the one line to fix once that's known.
function formatDobForVevo(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

// Best-effort label-based extraction — see this file's header for why
// this can't yet be verified against a real results page. Looks for each
// known field label and captures the text immediately following it up to
// the next line break, tolerant of the label and its value sharing a
// line (common in simple government result tables) or being on
// consecutive lines.
function parseResultText(text) {
  const grab = (label) => {
    const re = new RegExp(`${label}\\s*[:\\n]?\\s*([^\\n]{1,200})`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    visaClassSubclass: grab('Visa (?:class|subclass)'),
    grantDate: grab('(?:visa )?grant date'),
    expiryDate: grab('(?:visa )?expiry date'),
    workRights: grab('Work rights'),
    studyRights: grab('Study rights'),
    travelConditions: grab('Travel conditions'),
    specialConditions: grab('(?:special|any) conditions')
  };
}

async function runVevoCheck({ candidateId, candidateName, documentType, referenceType, referenceNumber, dateOfBirth, country, checkedByEmail, checkedByName }) {
  const documentTypeLabel = DOCUMENT_TYPE_LABELS[documentType];
  const referenceTypeLabel = REFERENCE_TYPE_LABELS[referenceType];
  if (!documentTypeLabel) throw new Error(`Unsupported document type "${documentType}" — expected passport or immicard.`);
  if (!referenceTypeLabel) throw new Error(`Unsupported reference type "${referenceType}" — expected trn, visa_evidence_number, or visa_grant_number.`);

  const id = uuidv4();
  const db = getDb();
  let outcome = 'error', result = null, rawText = null, errorMessage = null;

  // Same stealth-plugin requirement as services/acecqaSyncService.js —
  // NOT independently re-confirmed against THIS specific government
  // domain (only checked live that the form itself loads and has no
  // visible CAPTCHA), but immi.gov.au sits behind similar Akamai/
  // Cloudflare-style bot management to most Commonwealth sites, so the
  // same defensive default is used here rather than assuming plain
  // headless Chromium will work.
  const { chromium } = require('playwright-extra');
  const stealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromium.use(stealthPlugin());
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(VEVO_URL, { waitUntil: 'domcontentloaded' });

    await page.getByLabel('Document type').selectOption({ label: documentTypeLabel });
    // The reference type / DOB / document number / country fields only
    // exist in the DOM after Document type is chosen — confirmed live,
    // same staged-reveal pattern as the country dropdown only appearing
    // after selecting a document type in the real form.
    await page.getByRole('button', { name: 'Submit' }).click();

    await page.getByLabel('Reference type').selectOption({ label: referenceTypeLabel });
    await page.getByLabel('Date of birth').fill(formatDobForVevo(dateOfBirth));
    await page.getByLabel('Document number').fill(referenceNumber);
    await page.getByLabel('Country').selectOption({ label: country.toUpperCase() });
    await page.getByLabel('I have read and agree to the terms and conditions').check();

    await page.getByRole('button', { name: 'Submit' }).click();
    await page.waitForLoadState('domcontentloaded');

    rawText = await page.evaluate(() => document.body.innerText);
    if (/no match|no record|not found/i.test(rawText)) {
      outcome = 'no_match';
    } else {
      result = parseResultText(rawText);
      outcome = 'success';
    }
  } catch (err) {
    errorMessage = err.message;
  } finally {
    await browser.close();
  }

  await db.execute({
    sql: `INSERT INTO vevo_checks
            (id, candidate_id, candidate_name_input, document_type, reference_type, reference_number,
             date_of_birth, country, outcome, result, raw_result_text, error_message,
             checked_by_email, checked_by_name)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, candidateId || null, candidateName || null, documentType, referenceType, referenceNumber,
      dateOfBirth, country, outcome, result ? JSON.stringify(result) : null, rawText, errorMessage,
      checkedByEmail, checkedByName || checkedByEmail
    ]
  });

  if (errorMessage) throw new Error(errorMessage);
  return { id, outcome, result, rawResultText: rawText };
}

module.exports = { runVevoCheck, parseResultText, formatDobForVevo };
