const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

// Plain-text extraction only (no HTML/formatting) — used where the text is
// headed straight into an AI prompt rather than rendered as an article.
async function extractPlainText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return (await pdfParse(buffer)).text;
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer })).value;
  if (ext === '.txt') return buffer.toString('utf8');
  throw new Error('Unsupported file type. Please upload a .pdf, .docx, or .txt file.');
}

module.exports = { extractPlainText };
