const mammoth = require('mammoth');

// Joy, 2026-09-14: resume links (JobAdder attachments, e.g. the "Resume Link"
// column in her outreach sheets) already open PDFs inline in a new tab
// (routes/jobadderCandidates.js). But most resumes are .docx, and browsers
// have no built-in viewer for Word documents — clicking one always downloads,
// no matter what headers the server sends. This renders a .docx to a PDF
// on the fly (via mammoth's docx->HTML, then Playwright's own PDF export)
// so it can be served inline like any other PDF. Legacy .doc (binary OLE
// format, not zip/XML-based) isn't supported by mammoth — callers should
// catch and fall back to serving the original file for those.
async function convertDocxToPdf(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: Calibri, Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #111; max-width: 760px; margin: 24px auto; padding: 0 12px; }
    img { max-width: 100%; }
    table { border-collapse: collapse; }
    td, th { border: 1px solid #ccc; padding: 4px 8px; }
  </style></head><body>${html}</body></html>`;

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const browserPage = await browser.newPage();
    await browserPage.setContent(page, { waitUntil: 'networkidle' });
    return await browserPage.pdf({ format: 'A4', margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } });
  } finally {
    await browser.close();
  }
}

module.exports = { convertDocxToPdf };
