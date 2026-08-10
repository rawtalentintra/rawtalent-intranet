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

// Tesseract's English model (~5MB) is downloaded once and reused — without
// an explicit cachePath it drops the file in the process's cwd, which is
// the repo root in this app. Pointing it at the OS temp dir instead keeps
// that out of the working tree; it's re-downloaded on the first OCR call
// after a fresh deploy/restart, same as it would be otherwise.
const TESSERACT_CACHE_PATH = os.tmpdir();

const MIN_TEXT_LAYER_LENGTH = 40;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif']);

async function run() {
  const filePath = process.argv[2];
  const originalName = process.argv[3];
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.pdf') {
    const fs = require('fs');
    const pdfText = (await pdfParse(fs.readFileSync(filePath))).text.trim();
    if (pdfText.length >= MIN_TEXT_LAYER_LENGTH) {
      return { text: pdfText, method: 'pdf-text-layer', confidence: null };
    }
    throw new Error('This PDF has no readable text layer (likely a scanned copy) — please upload it as a JPG or PNG instead so it can be OCR\'d.');
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    const { data } = await Tesseract.recognize(filePath, 'eng', { cachePath: TESSERACT_CACHE_PATH });
    return { text: data.text.trim(), method: 'tesseract-ocr', confidence: Math.round(data.confidence) };
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
