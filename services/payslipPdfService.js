const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, '../public/images/RawTalent-LOGO.png');
const NAVY = '#0b1d3e';
const MUTED = '#4f5e7b';
const LEFT_X = 50;
const RIGHT_X = 320;
const CONTENT_WIDTH = 495;
const PAGE_W = 595.28;
const ROW_H = 15;

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDateLong(d) {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Renders a payslip PDF matching RawTalent's existing external template
// exactly (verified against 5 real sample payslips). Pure function — no
// DB/storage access — so it can back both the persisted "generate" flow
// and a zero-write "preview" flow from the same code path.
//
// Every row is drawn with an explicitly-tracked y coordinate rather than
// relying on pdfkit's implicit cursor advance — text() moves doc.y as a
// side effect by default, which silently desyncs a multi-column layout
// (label at one x, value at another x, both meant to sit on the same
// row) the moment any call in between reads doc.y again. Each row/field
// helper here returns its own height and the caller advances a single y
// variable explicitly.
//
// payslip: { invoiceNumber, referenceNo, userName, designation, address,
//   payPeriodStart, payPeriodEnd, datePaid, workedDays, lineItems, totalEarningsAud,
//   exchangeRate, totalEarningsPhp, paysInPhp }
// profile: { bankName, bankAccountName, bankAccountNumber, bankSwiftCode }
function buildPayslipPdf(payslip, profile) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, left: 50, right: 50, bottom: 50 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header — logo + letterhead, centered
    try { doc.image(LOGO_PATH, (PAGE_W - 150) / 2, doc.y, { width: 150 }); doc.y += 62; } catch { doc.y += 10; }
    doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('Payslip', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 16;
    doc.font('Helvetica-Bold').fontSize(10).text('Raw Talent Recruitment', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 13;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text('Level 5|111, Cecil St, South Melbourne VIC 3205, Australia', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 26;
    doc.fillColor('black');

    // label:value pair at an explicit (x,y) — returns the row height taken
    // (at least ROW_H, more if the value wraps, e.g. a long Address).
    function field(x, y, label, value, valueWidth, labelWidth = 95) {
      doc.font('Helvetica').fontSize(9.5);
      doc.text(label, x, y, { width: labelWidth, lineBreak: false });
      const h = doc.heightOfString(`: ${value}`, { width: valueWidth });
      doc.text(`: ${value}`, x + labelWidth, y, { width: valueWidth });
      return Math.max(ROW_H, h);
    }

    // Two-column info block
    let leftY = doc.y;
    let rightY = doc.y;
    leftY += field(LEFT_X, leftY, 'Invoice Number', payslip.invoiceNumber, 110);
    leftY += field(LEFT_X, leftY, 'Reference/PO', payslip.referenceNo, 110) + 10;
    leftY += field(LEFT_X, leftY, 'Pay Period', `${fmtDateLong(payslip.payPeriodStart)} - ${fmtDateLong(payslip.payPeriodEnd)}`, 130);
    leftY += field(LEFT_X, leftY, 'Date Paid', fmtDateLong(payslip.datePaid), 130);
    leftY += field(LEFT_X, leftY, 'Worked Days', String(payslip.workedDays), 130);

    rightY += field(RIGHT_X, rightY, 'Employee name', payslip.userName, 175);
    rightY += field(RIGHT_X, rightY, 'Designation', payslip.designation || '-', 175);
    rightY += field(RIGHT_X, rightY, 'Address', payslip.address || '-', 175);

    doc.y = Math.max(leftY, rightY) + 14;

    // Bank Details — heading at LEFT_X, fields at RIGHT_X, same starting row
    // (matches the real template exactly, not a stacked block).
    const bankTop = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).text('Bank Details', LEFT_X, bankTop, { width: 150, lineBreak: false });
    let bankY = bankTop;
    bankY += field(RIGHT_X, bankY, 'Bank Name', profile.bankName || '-', 175);
    bankY += field(RIGHT_X, bankY, 'Account Name', profile.bankAccountName || '-', 175);
    bankY += field(RIGHT_X, bankY, 'Account Number', profile.bankAccountNumber || '-', 175);
    bankY += field(RIGHT_X, bankY, 'Swift Code', profile.bankSwiftCode || '-', 175);
    doc.y = bankY + 14;

    // Shift Details table
    const colHourX = LEFT_X + 330;
    const colAmountX = LEFT_X + 410;

    function drawTableHeader() {
      doc.rect(LEFT_X, doc.y, CONTENT_WIDTH, 20).fill('#e5e7eb');
      const hy = doc.y + 6;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5);
      doc.text('Shift Details', LEFT_X + 6, hy, { width: 300, lineBreak: false });
      doc.text('Total Hour', colHourX, hy, { width: 70, align: 'right', lineBreak: false });
      doc.text('Amount', colAmountX, hy, { width: 75, align: 'right', lineBreak: false });
      doc.y += 24;
      doc.fillColor('black').font('Helvetica').fontSize(9.5);
    }
    drawTableHeader();

    // Prints groupLabel only when it changes from the previous row — this
    // is what reproduces the real template's "Sunday Shift:" grouping,
    // where the group is printed once and subsequent dated sub-rows sit
    // indented under it with no repeated label.
    let prevGroup = null;
    for (const item of payslip.lineItems) {
      if (doc.y > 740) { doc.addPage(); doc.y = 50; drawTableHeader(); prevGroup = null; }
      const rowY = doc.y;
      const showGroup = item.groupLabel && item.groupLabel !== prevGroup;
      if (showGroup) doc.text(item.groupLabel, LEFT_X, rowY, { width: 145, lineBreak: false });
      if (item.label) doc.text(item.label, LEFT_X + 150, rowY, { width: 175, lineBreak: false });
      doc.text(Number(item.hours).toFixed(2), colHourX, rowY, { width: 70, align: 'right', lineBreak: false });
      doc.text(fmtMoney(item.amount), colAmountX, rowY, { width: 75, align: 'right', lineBreak: false });
      doc.y = rowY + ROW_H;
      prevGroup = item.groupLabel || prevGroup;
    }

    doc.moveTo(LEFT_X, doc.y + 4).lineTo(LEFT_X + CONTENT_WIDTH, doc.y + 4).strokeColor('#d1d5db').stroke();
    doc.y += 12;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Total Earnings in AUD', LEFT_X, doc.y, { width: 340, lineBreak: false });
    doc.text(fmtMoney(payslip.totalEarningsAud), colAmountX, doc.y, { width: 75, align: 'right', lineBreak: false });
    doc.y += 26;
    doc.font('Helvetica').fontSize(9.5);

    if (payslip.paysInPhp) {
      doc.rect(LEFT_X, doc.y, CONTENT_WIDTH, 20).fill('#e5e7eb');
      const hy = doc.y + 6;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5).text('Convertion', LEFT_X + 6, hy, { width: 300, lineBreak: false });
      doc.text('Amount', colAmountX, hy, { width: 75, align: 'right', lineBreak: false });
      doc.y += 24;
      doc.fillColor('black').font('Helvetica').fontSize(9.5);
      doc.text('Currency Exchange Rate', LEFT_X, doc.y, { width: 340, lineBreak: false });
      doc.text(Number(payslip.exchangeRate).toFixed(2), colAmountX, doc.y, { width: 75, align: 'right', lineBreak: false });
      doc.y += 20;
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text('Total Earnings in PHP', LEFT_X, doc.y, { width: 340, lineBreak: false });
      doc.text(fmtMoney(payslip.totalEarningsPhp), colAmountX, doc.y, { width: 75, align: 'right', lineBreak: false });
      doc.y += 20;
    }

    doc.y = Math.max(doc.y + 40, 720);
    doc.font('Helvetica-BoldOblique').fontSize(9).fillColor(MUTED)
      .text('This is system generated payslip', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 12;
    doc.font('Helvetica-Oblique').fontSize(9)
      .text('by Raw Talent Recruitment', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });

    doc.end();
  });
}

module.exports = { buildPayslipPdf };
