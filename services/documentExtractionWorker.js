// Runs as a standalone child process (spawned by documentCheckerService.js),
// never imported directly — one process per extraction, always. pdf-parse's
// bundled pdf.js and tesseract.js's WASM runtime were found to corrupt each
// other's state when loaded in the same long-running process: after any
// Tesseract OCR call, the next pdf-parse call in that process either throws
// "bad XRef entry" on a perfectly valid PDF, or worse, resolves fine but
// leaves a stray background promise that rejects later as an *unhandled*
// rejection — which crashes the whole Node process by default. Giving every
// extraction its own disposable process sidesteps the interaction entirely:
// there's no shared module state left to corrupt, and if either library
// hard-crashes on a bad file, only this child dies.
const os = require('os');
const path = require('path');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

// Tesseract's English model (~5MB) is downloaded once and reused — without
// an explicit cachePath it drops the file in the process's cwd, which is
// the repo root in this app. Pointing it at the OS temp dir instead keeps
// that out of the working tree; it's re-downloaded on the first OCR call
// after a fresh deploy/restart, same as it would be otherwise.
const TESSERACT_CACHE_PATH = os.tmpdir();

const MIN_TEXT_LAYER_LENGTH = 40;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif']);

// ── Phase 2 (2026-09-09) — non-AI photo-quality signals ─────────────────
// Only meaningful for an actual photo (the image-upload path) — a PDF with
// a real text layer is a native digital document, not a photo of one, so
// "is this a clear photo" doesn't apply to it at all (quality stays null
// for that path, same as confidence already does).
//
// Three cheap, deterministic measurements, no AI/ML model involved:
//  - resolution: too small to ever have been a legible full-page scan.
//  - brightness: mean grey value — catches a blown-out (glare/flash) or
//    near-black (underexposed/finger-over-lens) photo.
//  - blurVariance: the standard "variance of Laplacian" sharpness metric
//    (the same formula behind OpenCV's well-known cv2.Laplacian(img).var()
//    blur check) — a Laplacian edge-detection kernel responds strongly to
//    sharp edges and weakly to smooth/blurred regions, so the VARIANCE of
//    its response across the whole image is low for a blurry photo and
//    high for a sharp, in-focus one. Computed here via sharp's own
//    convolve()+stats() instead of pulling in a full CV library for one
//    number — stdev of a single-channel greyscale image, squared, is
//    exactly that variance.
// Thresholds (documentCheckerService.js) were calibrated against real
// production documents, not chosen abstractly — see that file's comment for
// the actual before/after numbers a known-poor real scan produced.
const LAPLACIAN_KERNEL = { width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] };

// Found empirically against a real uploaded file (2026-09-09, an iOS
// screenshot saved as PNG): its metadata reports depth:'ushort'/16-bit
// (space 'rgb16') rather than the normal 8-bit sRGB every JPEG photo uses,
// and sharp's greyscale()+stats() on it returned a mean of ~6192 and a
// blur-variance north of 177 MILLION — both numbers on a 0-65535 scale, not
// the expected 0-255 one, which would have silently corrupted every
// downstream brightness/blur threshold for that file. Round-tripping
// through a JPEG buffer first FORCES standard 8-bit sRGB output regardless
// of the source's original depth/colourspace/ICC profile, so brightness and
// blur are always measured on the same scale no matter what format was
// uploaded. Skipped for files already reporting normal 8-bit depth (the
// large majority — ordinary phone-camera JPEGs) so a normal file isn't put
// through an unnecessary second lossy compression pass that could itself
// soften edges and skew the blur reading.
// `source` is a file path for a real image upload, or an in-memory PNG
// Buffer for one rasterized page of a scanned PDF (Phase 3) — sharp accepts
// either identically, so the same function covers both without change.
async function computeImageQuality(source) {
  const meta = await sharp(source).metadata();
  const needsNormalizing = meta.depth !== 'uchar';
  const normalized = needsNormalizing
    ? await sharp(source).rotate().jpeg({ quality: 92 }).toBuffer()
    : source;
  const brightnessStats = await sharp(normalized).rotate().greyscale().stats();
  const sharpnessStats = await sharp(normalized).rotate().greyscale().convolve(LAPLACIAN_KERNEL).stats();
  return {
    width: meta.width || null,
    height: meta.height || null,
    brightness: Math.round(brightnessStats.channels[0].mean),
    blurVariance: Math.round(sharpnessStats.channels[0].stdev ** 2)
  };
}

// ── Phase 3 (2026-09-09) — scanned-PDF support ───────────────────────────
// A PDF with no real text layer used to be a hard dead end here ("upload as
// JPG/PNG instead") — a live query against real production documents found
// ~30% of real PDF uploads sampled are genuinely scanned copies with no text
// layer at all, so this was a real, common gap, not an edge case. Rasterizes
// each page to a PNG (pdf-to-png-converter, itself pdfjs-dist +
// @napi-rs/canvas — both ship prebuilt native binaries, no system package
// like poppler needed on Railway) and runs the exact same Tesseract OCR +
// photo-quality pipeline already built for a real image upload, page by
// page. Capped at MAX_SCANNED_PDF_PAGES — compliance documents are
// realistically always 1-2 pages; a cap bounds worst-case OCR time on
// whatever multi-page PDF someone attaches instead of letting it run
// unbounded.
const MAX_SCANNED_PDF_PAGES = 5;

async function ocrScannedPdf(buffer) {
  const { pdfToPng } = require('pdf-to-png-converter');
  const pages = await pdfToPng(buffer, { viewportScale: 2.5, pagesToProcess: Array.from({ length: MAX_SCANNED_PDF_PAGES }, (_, i) => i + 1) });
  if (!pages.length) throw new Error('This PDF could not be rasterized for OCR — it may be corrupted or password-protected.');

  const texts = [];
  const confidences = [];
  const qualities = [];
  for (const page of pages) {
    const { data } = await Tesseract.recognize(page.content, 'eng', { cachePath: TESSERACT_CACHE_PATH });
    texts.push(data.text.trim());
    confidences.push(data.confidence);
    qualities.push(await computeImageQuality(page.content).catch(() => null));
  }

  // Multiple pages are reported as one combined result, not one per page —
  // check-from-rt (routes/documentChecker.js) and every checker in
  // documentCheckerService.js already work on a single block of text/one
  // quality reading per document, same as a single-page image upload
  // always has. Confidence/quality are averaged across pages rather than
  // e.g. taking the worst page, since a mostly-clear multi-page scan
  // shouldn't read as badly as its single worst page.
  const validQualities = qualities.filter(Boolean);
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  return {
    text: texts.join('\n\n').trim(),
    method: 'scanned-pdf-ocr',
    confidence: avg(confidences),
    quality: validQualities.length ? {
      width: Math.min(...validQualities.map(q => q.width || Infinity)),
      height: Math.min(...validQualities.map(q => q.height || Infinity)),
      brightness: avg(validQualities.map(q => q.brightness)),
      blurVariance: avg(validQualities.map(q => q.blurVariance))
    } : null
  };
}

async function run() {
  const filePath = process.argv[2];
  const originalName = process.argv[3];
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.pdf') {
    const fs = require('fs');
    const buffer = fs.readFileSync(filePath);
    const pdfText = (await pdfParse(buffer)).text.trim();
    if (pdfText.length >= MIN_TEXT_LAYER_LENGTH) {
      return { text: pdfText, method: 'pdf-text-layer', confidence: null, quality: null };
    }
    return ocrScannedPdf(buffer);
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    const [{ data }, quality] = await Promise.all([
      Tesseract.recognize(filePath, 'eng', { cachePath: TESSERACT_CACHE_PATH }),
      // Independent of OCR entirely — still computed even if Tesseract
      // fails to read anything at all, since "couldn't read it AND the
      // photo is objectively blurry" is more useful to a reviewer than
      // either signal alone. A quality-analysis failure (corrupt image,
      // unsupported colour space) shouldn't take down the whole check
      // though — OCR's own result already carries a confidence score, so
      // quality staying null here just means one fewer flag downstream,
      // not a broken check.
      computeImageQuality(filePath).catch(() => null)
    ]);
    return { text: data.text.trim(), method: 'tesseract-ocr', confidence: Math.round(data.confidence), quality };
  }

  throw new Error('Unsupported file type. Please upload a PDF, JPG, or PNG.');
}

run()
  .then(result => { process.stdout.write(JSON.stringify({ ok: true, result })); process.exit(0); })
  .catch(err => { process.stdout.write(JSON.stringify({ ok: false, error: err.message })); process.exit(0); });

// A stray background rejection from either library (the actual root cause
// above) lands here instead of crashing the real API server — this process
// is disposable, so print what we can and exit rather than letting Node's
// default unhandled-rejection behavior take the process down mid-write.
process.on('unhandledRejection', (reason) => {
  try { process.stdout.write(JSON.stringify({ ok: false, error: (reason && reason.message) || String(reason) })); } catch {}
  process.exit(0);
});
