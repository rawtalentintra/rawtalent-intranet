const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');

// ── AI fallback extraction — explicit, per-document, last resort ─────────
// documentCheckerService.js's own header is blunt about this: "The whole
// point of this feature is avoiding AI credits". Every check still runs
// through that exact same free, deterministic pipeline first, with zero
// change to it. This file exists only for the genuine minority of real
// documents where that pipeline comes back with an honest gap — no name
// found, no date found, or the document type itself unconfirmed — because
// the real template just isn't one of the regex patterns built from the
// real samples seen so far (documentCheckerService.js's own comments name
// several of these exact gaps: two Qualification-certificate name templates,
// several WWCC layouts, etc.). Regex either finds real structured data with
// certainty or finds nothing at all; it has no way to make a reasonable
// guess from messy, low-confidence OCR text the way a language model can.
//
// So this is deliberately NOT run automatically, ever — not from a single
// "Check Document" click, not from the nightly bulk sweep. It only runs
// when a human, looking at a specific check that already came back with a
// real gap, explicitly clicks "Run AI Check" (routes/documentChecker.js's
// POST /:id/ai-check) and accepts that this one document, and only this
// one, will cost a small amount of real AI credit — the opposite of every
// other check this feature runs, which are all free. The result is always
// additive: it's stored alongside the original deterministic outcome/
// flags/reasons (never overwriting them) and is capped so it can never by
// itself turn an already-decided outcome into 'valid' — a plausible-
// sounding name or date from a language model is a strong hint for the
// human reviewer, not proof, exactly the same "surface it, don't decide it
// for a human" principle the rest of this feature already follows for its
// own fake-document heuristics.
function isAiFallbackWorthwhile(extracted, flags) {
  if (!extracted) return false;
  if (!extracted.documentTypeConfirmed) return true;
  if (!extracted.applicantName) return true;
  // Only meaningful for a document type that's actually supposed to have an
  // issue date at all — checkPassport's birth_certificate/citizenship
  // branches, and any 'no_expiry' compliance_requirements row, legitimately
  // have issueDate: null with nothing wrong. no_issue_date_found is the
  // real, specific flag every expiring-document checker raises only when a
  // date genuinely should have been there and wasn't found — that's the
  // actual signal to use, not a blanket "issueDate is null" check.
  if ((flags || []).includes('no_issue_date_found')) return true;
  return false;
}

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// One tool call, forced — same pattern as faqClassifier.js/callGradingService.js
// elsewhere in this app, chosen for the same reason: messy real OCR text
// (stray line breaks, garbled characters) is exactly the kind of input
// that can produce genuinely unparseable free-text JSON, where a forced
// tool call can't.
const EXTRACT_TOOL = {
  name: 'submit_extraction',
  description: 'Submit your best-effort extraction of this compliance document, being explicit about what you could and could not find.',
  input_schema: {
    type: 'object',
    properties: {
      looksLikeExpectedType: { type: 'boolean', description: 'Does this text genuinely look like the expected document type (given in the prompt), as opposed to a clearly different document or something unreadable?' },
      applicantName: { type: ['string', 'null'], description: 'The person\'s full name as printed on the document, or null if you genuinely cannot find one.' },
      issueDate: { type: ['string', 'null'], description: 'The document\'s issue/effective date in YYYY-MM-DD, or null if none is findable.' },
      expiryDate: { type: ['string', 'null'], description: 'The document\'s expiry date in YYYY-MM-DD, or null if none is stated or the document type has no expiry.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Your own honest confidence in this extraction given how messy/garbled the OCR text is.' },
      note: { type: 'string', description: 'One or two plain-English sentences for a human reviewer: what you found, what you could not find, and anything about the text that made it hard to read.' }
    },
    required: ['looksLikeExpectedType', 'applicantName', 'issueDate', 'expiryDate', 'confidence', 'note']
  }
};

// Real evidence this needed to exist (2026-09-12): a genuine WWCC photo
// scored 53% Tesseract confidence — ABOVE MIN_OCR_CONFIDENCE (45, see
// documentCheckerService.js) so no quality flag fired at all — yet the
// actual extracted text was "WORKING WITH CHILDREN CHECK\n\nBi 0 == E
// ae\nS == | \\\n\n= TORIA = 4 /": the card's own heading read perfectly
// (hence a not-terrible average confidence) while literally everything
// else — name, number, expiry — read as pure noise. Re-running text-only
// extraction against that same garbled text can't recover information
// the OCR pass never actually captured; the information genuinely still
// exists, just in the IMAGE, not in the text Tesseract produced from it.
// A vision-capable model reading the real photo directly is a
// categorically different, more powerful capability than re-prompting
// over already-lossy OCR output — this is what actually answers "automate
// getting the info from the photo" rather than "try the same text again."
// Text is still sent alongside the image (when available) as a second,
// free signal Claude can cross-check against, but the image is the part
// doing the real work here.
const IMAGE_MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

async function extractWithAi(text, documentType, candidateName, imageAttachment) {
  const client = getClient();
  if (!client) throw new Error('AI is not configured (ANTHROPIC_API_KEY missing) — contact your administrator.');

  const content = [];
  if (imageAttachment) {
    content.push({
      type: imageAttachment.mediaType === 'application/pdf' ? 'document' : 'image',
      source: { type: 'base64', media_type: imageAttachment.mediaType, data: imageAttachment.base64 }
    });
  }
  content.push({
    type: 'text',
    text: imageAttachment
      ? `Here is the actual document image, plus the OCR text our free automated pass extracted from it (for reference/cross-checking only — the image is ground truth, the OCR text may well be wrong or garbled):\n\n${(text || '(no usable OCR text at all)').slice(0, 8000)}`
      : (text || '').slice(0, 12000)
  });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `You are doing a second-look, best-effort extraction on a compliance document, after RawTalent's own deterministic rules-based checker already tried and came back with a genuine gap (no name/date found, or the document type unconfirmed). This is a real childcare-industry compliance document (expected type: "${documentType}"${candidateName ? `, expected to belong to "${candidateName}"` : ''}).${imageAttachment ? ' You have the actual document image — read directly off it rather than relying on the (possibly poor) OCR text also provided.' : ' Only OCR text is available for this one (no source image could be re-fetched) — it may be messy, have stray line breaks, or be genuinely garbled in places.'} Do your honest best and say so plainly in your note rather than inventing anything you're not genuinely seeing. Call submit_extraction exactly once.`,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_extraction' },
    messages: [{ role: 'user', content }]
  });

  const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_extraction');
  if (!toolUse) throw new Error('AI did not return a usable extraction.');
  return toolUse.input;
}

// Runs the AI pass for one already-saved document_checks row, stores the
// result on that same row (ai_* columns only — never touches the original
// outcome/flags/reasons/extracted_fields), and returns the updated row.
// Re-fetches the real source file from RT (same S3 host allowlist
// routes/documentChecker.js already enforces) to hand Claude the actual
// image, not just the lossy OCR text — see extractWithAi's own comment
// for why that distinction is the entire point of this upgrade. Falls
// back to text-only if the re-fetch fails or the file type isn't one
// Claude can read as vision input (e.g. a scanned-PDF-of-a-photo edge
// case) rather than failing the whole AI check outright.
async function runAiFallbackForCheck(checkId, requestedByEmail) {
  const db = getDb();
  const row = (await db.execute({ sql: 'SELECT * FROM document_checks WHERE id = ?', args: [checkId] })).rows[0];
  if (!row) throw new Error('Document check not found.');
  if (!row.extracted_text && !row.document_source_url) throw new Error('No stored OCR text or source document for this check to re-analyse.');

  let imageAttachment = null;
  if (row.document_source_url) {
    try {
      // Lazy require — see routes/documentChecker.js's own bulk-check
      // comment for why (this file loading fully before that one
      // requires it back would otherwise be a circular require; a
      // require() inside a function body that only runs long after both
      // modules have finished loading sidesteps that entirely).
      const { fetchRtDocument } = require('../routes/documentChecker');
      const { buffer, filename } = await fetchRtDocument(row.document_source_url);
      const ext = (filename.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
      const mediaType = ext === '.pdf' ? 'application/pdf' : IMAGE_MEDIA_TYPES[ext];
      if (mediaType) imageAttachment = { mediaType, base64: buffer.toString('base64') };
    } catch (err) {
      console.error(`AI fallback: could not re-fetch source document for check ${checkId}, falling back to text-only:`, err.message);
    }
  }

  const extraction = await extractWithAi(row.extracted_text, row.document_type, row.candidate_name_input, imageAttachment);
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE document_checks SET ai_assist_used = true, ai_extracted_fields = ?, ai_note = ?, ai_requested_by = ?, ai_requested_at = ? WHERE id = ?`,
    args: [JSON.stringify(extraction), extraction.note, requestedByEmail, now, checkId]
  });
  return { ...row, ai_assist_used: true, ai_extracted_fields: extraction, ai_note: extraction.note, ai_requested_by: requestedByEmail, ai_requested_at: now };
}

module.exports = { isAiFallbackWorthwhile, extractWithAi, runAiFallbackForCheck };
