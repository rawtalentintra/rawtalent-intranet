const path = require('path');

// pdfkit's built-in "Helvetica"/"Helvetica-Bold" are the standard 14 PDF
// fonts — WinAnsiEncoding only, no Thai (or other non-Latin) glyph
// coverage at all. Real stored data does contain Thai script (e.g.
// Sophia Arwae's actual address in team_members.address), which rendered
// as garbled mojibake on both individual payslips and the Team Invoice
// until this was found and fixed (2026-08-28). Noto Sans Thai — SIL Open
// Font License, see public/fonts/NotoSansThai-OFL.txt — covers Thai and
// Latin in one face, so it's registered as the one body font for every
// piece of text in these documents that might contain employee-sourced
// data (names, addresses, positions), not just the Thai-specific parts.
// The two italic footer lines ("This is a system generated payslip...")
// are hardcoded ASCII and stay on pdfkit's built-in Helvetica-Oblique —
// no Thai coverage needed there, and downloading a third (italic) weight
// just for two fixed lines isn't worth it.
const REGULAR_PATH = path.join(__dirname, '../public/fonts/NotoSansThai-Regular.ttf');
const BOLD_PATH = path.join(__dirname, '../public/fonts/NotoSansThai-Bold.ttf');
const REGULAR = 'Body';
const BOLD = 'Body-Bold';

function registerUnicodeFonts(doc) {
  doc.registerFont(REGULAR, REGULAR_PATH);
  doc.registerFont(BOLD, BOLD_PATH);
}

module.exports = { registerUnicodeFonts, REGULAR, BOLD };
