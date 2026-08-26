const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, '../public/images/RawTalent-LOGO.png');
const NAVY = '#0b1d3e';
const ACCENT = '#3d6fff'; // matches the app's --orange (actually blue) accent
const MUTED = '#4f5e7b';
const LEFT_X = 50;
const CONTENT_WIDTH = 495;
const PAGE_W = 595.28;
const ROW_H = 15;

// Two-column geometry for the info/bank cards — computed so neither
// column's value area can overflow the page margin (the previous version
// put the right column's value box past the printable width, which is
// what made the Employee/Bank fields look misaligned rather than actually
// being a text-wrapping quirk).
const COL_PAD = 16; // inner padding of each card
const LEFT_LABEL_W = 88;
const LEFT_VALUE_W = 140;
const RIGHT_X = LEFT_X + COL_PAD + LEFT_LABEL_W + LEFT_VALUE_W + 20; // gutter between columns
const RIGHT_LABEL_W = 90;
const RIGHT_VALUE_W = (LEFT_X + CONTENT_WIDTH) - COL_PAD - RIGHT_X - RIGHT_LABEL_W;

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDateLong(d) {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Renders a payslip PDF for RawTalent — pure function, no DB/storage
// access — so it can back both the persisted "generate" flow and a
// zero-write "preview" flow from the same code path.
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

    // ── Header: logo, then a rule marking it off as its own masthead
    // band, then the title treatment below — rather than the logo just
    // trailing straight into plain "Payslip" text with no visual break. ──
    doc.y = 42;
    try { doc.image(LOGO_PATH, (PAGE_W - 130) / 2, doc.y, { width: 130 }); doc.y += 46; } catch { doc.y += 10; }
    doc.moveTo(LEFT_X, doc.y).lineTo(LEFT_X + CONTENT_WIDTH, doc.y).lineWidth(1).strokeColor('#e2e8f0').stroke();
    doc.y += 22;

    doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY)
      .text('PAYSLIP', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center', characterSpacing: 3 });
    doc.y += 30;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY)
      .text('Raw Talent Recruitment', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 14;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text('Level 5|111, Cecil St, South Melbourne VIC 3205, Australia', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 34; // deliberate breathing room before the info card starts
    doc.fillColor('black');

    // label:value pair at an explicit (x,y) — returns the row height taken
    // (at least ROW_H, more if the value wraps).
    // measure=true only computes the height a field would take (pdfkit's
    // heightOfString has no drawing side effect) without painting
    // anything — needed because a card's tinted background has to be
    // drawn BEFORE its text, but the card's height isn't known until
    // after laying out that same text. Drawing the fill after the text
    // (the first version of this file did that) just paints over and
    // hides everything already written.
    function field(x, y, label, value, valueWidth, labelWidth, measure) {
      const h = Math.max(ROW_H, doc.heightOfString(`: ${value}`, { width: valueWidth }));
      if (measure) return h;
      doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
      doc.text(label, x, y, { width: labelWidth, lineBreak: false });
      doc.fillColor('black');
      doc.text(`: ${value}`, x + labelWidth, y, { width: valueWidth });
      return h;
    }

    // A light tinted card behind a block of fields, with a small colored
    // section label riding on its top edge — the "this is one section"
    // indicator that was missing before, matching the light-highlight
    // convention already used elsewhere in the app.
    function sectionCard(y, height, label, fill, accent) {
      doc.roundedRect(LEFT_X, y, CONTENT_WIDTH, height, 6).fill(fill);
      doc.roundedRect(LEFT_X, y, 4, height, 2).fill(accent);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(accent)
        .text(label.toUpperCase(), LEFT_X + COL_PAD, y + 10, { characterSpacing: 0.5 });
    }

    // Lays out the Invoice/Pay-Period/Employee block; measure=true skips
    // all drawing and just returns the block's total height so the card
    // background can be sized and painted first.
    function layoutInfoBlock(top, measure) {
      const bodyTop = top + 28;
      let leftY = bodyTop;
      let rightY = bodyTop;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Invoice No.', payslip.invoiceNumber, LEFT_VALUE_W, LEFT_LABEL_W, measure) + 4;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Reference/PO', payslip.referenceNo, LEFT_VALUE_W, LEFT_LABEL_W, measure) + 4;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Date Paid', fmtDateLong(payslip.datePaid), LEFT_VALUE_W, LEFT_LABEL_W, measure) + 4;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Worked Days', String(payslip.workedDays), LEFT_VALUE_W, LEFT_LABEL_W, measure);

      rightY += field(RIGHT_X, rightY, 'Employee', payslip.userName, RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 4;
      rightY += field(RIGHT_X, rightY, 'Designation', payslip.designation || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 4;
      rightY += field(RIGHT_X, rightY, 'Address', payslip.address || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure);

      // Pay Period gets its own full-width row below both columns — it's
      // a long date range and previously got crammed into the narrow
      // left column, wrapping onto two lines and throwing the columns'
      // rhythm off. One line, full width, is what actually reads as
      // "aligned."
      const columnsBottom = Math.max(leftY, rightY) + 8;
      const ppLabelW = 90;
      if (!measure) {
        doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
          .text('Pay Period', LEFT_X + COL_PAD, columnsBottom, { width: ppLabelW, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY)
          .text(`: ${fmtDateLong(payslip.payPeriodStart)}  –  ${fmtDateLong(payslip.payPeriodEnd)}`, LEFT_X + COL_PAD + ppLabelW, columnsBottom, { width: CONTENT_WIDTH - 2 * COL_PAD - ppLabelW, lineBreak: false });
      }
      return (columnsBottom + ROW_H + 12) - top;
    }

    const bankColGap = RIGHT_X - LEFT_X - COL_PAD - LEFT_LABEL_W - LEFT_VALUE_W;
    // Lays out the Bank Details block the same measure/draw way.
    function layoutBankBlock(top, measure) {
      const bodyTop = top + 28;
      let bankY = bodyTop;
      bankY += field(LEFT_X + COL_PAD, bankY, 'Bank Name', profile.bankName || '-', LEFT_VALUE_W + bankColGap, LEFT_LABEL_W, measure) + 4;
      bankY += field(LEFT_X + COL_PAD, bankY, 'Account Name', profile.bankAccountName || '-', LEFT_VALUE_W + bankColGap, LEFT_LABEL_W, measure) + 4;
      let bankY2 = bodyTop;
      bankY2 += field(RIGHT_X, bankY2, 'Account No.', profile.bankAccountNumber || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 4;
      bankY2 += field(RIGHT_X, bankY2, 'Swift Code', profile.bankSwiftCode || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 4;
      return (Math.max(bankY, bankY2) + 8) - top;
    }

    // ── Invoice / Pay Period / Employee card ──────────────────────
    const infoTop = doc.y;
    const infoHeight = layoutInfoBlock(infoTop, true);
    sectionCard(infoTop, infoHeight, 'Payslip Details', '#eff6ff', ACCENT);
    layoutInfoBlock(infoTop, false);
    doc.y = infoTop + infoHeight + 18;
    doc.fillColor('black');

    // ── Bank Details card — own tint so it reads as a distinct, more
    // sensitive section rather than a continuation of the info above. ──
    const bankTop = doc.y;
    const bankHeight = layoutBankBlock(bankTop, true);
    sectionCard(bankTop, bankHeight, 'Bank Details', '#fdf4ff', '#a855f7');
    layoutBankBlock(bankTop, false);
    doc.y = bankTop + bankHeight + 22;
    doc.fillColor('black');

    // ── Shift Details table ────────────────────────────────────────
    const colHourX = LEFT_X + 330;
    const colAmountX = LEFT_X + 410;

    function drawTableHeader() {
      doc.roundedRect(LEFT_X, doc.y, CONTENT_WIDTH, 22, 4).fill(NAVY);
      const hy = doc.y + 7;
      doc.fillColor('white').font('Helvetica-Bold').fontSize(9.5);
      doc.text('Shift Details', LEFT_X + 10, hy, { width: 300, lineBreak: false });
      doc.text('Total Hour', colHourX, hy, { width: 70, align: 'right', lineBreak: false });
      doc.text('Amount', colAmountX, hy, { width: 75, align: 'right', lineBreak: false });
      doc.y += 26;
      doc.fillColor('black').font('Helvetica').fontSize(9.5);
    }
    drawTableHeader();

    // Prints groupLabel only when it changes from the previous row —
    // reproduces grouped shift rows (e.g. "Week 1: …") printed once with
    // dated sub-rows sitting under it, not repeated per row. Alternating
    // row tint replaces the previous plain list so a long line-item list
    // stays readable/aligned at a glance.
    let prevGroup = null;
    let rowIndex = 0;
    for (const item of payslip.lineItems) {
      if (doc.y > 740) { doc.addPage(); doc.y = 50; drawTableHeader(); prevGroup = null; rowIndex = 0; }
      const rowY = doc.y;
      if (rowIndex % 2 === 1) doc.rect(LEFT_X, rowY - 3, CONTENT_WIDTH, ROW_H).fill('#f8fafc');
      doc.fillColor('black').font('Helvetica').fontSize(9.5);
      const showGroup = item.groupLabel && item.groupLabel !== prevGroup;
      if (showGroup) doc.font('Helvetica-Bold').fillColor(NAVY).text(item.groupLabel, LEFT_X + 10, rowY, { width: 145, lineBreak: false });
      doc.font('Helvetica').fillColor('black');
      if (item.label) doc.text(item.label, LEFT_X + 160, rowY, { width: 165, lineBreak: false });
      doc.text(Number(item.hours).toFixed(2), colHourX, rowY, { width: 70, align: 'right', lineBreak: false });
      doc.text(fmtMoney(item.amount), colAmountX, rowY, { width: 75, align: 'right', lineBreak: false });
      doc.y = rowY + ROW_H;
      prevGroup = item.groupLabel || prevGroup;
      rowIndex++;
    }

    doc.moveTo(LEFT_X, doc.y + 4).lineTo(LEFT_X + CONTENT_WIDTH, doc.y + 4).strokeColor('#d1d5db').stroke();
    doc.y += 14;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY);
    doc.text('Total Earnings in AUD', LEFT_X, doc.y, { width: 340, lineBreak: false });
    doc.text(fmtMoney(payslip.totalEarningsAud), colAmountX, doc.y, { width: 75, align: 'right', lineBreak: false });
    doc.y += 28;
    doc.font('Helvetica').fontSize(9.5).fillColor('black');

    if (payslip.paysInPhp) {
      doc.roundedRect(LEFT_X, doc.y, CONTENT_WIDTH, 22, 4).fill(NAVY);
      const hy = doc.y + 7;
      doc.fillColor('white').font('Helvetica-Bold').fontSize(9.5).text('Currency Conversion', LEFT_X + 10, hy, { width: 300, lineBreak: false });
      doc.text('Amount', colAmountX, hy, { width: 75, align: 'right', lineBreak: false });
      doc.y += 26;
      doc.fillColor('black').font('Helvetica').fontSize(9.5);
      doc.text('Currency Exchange Rate', LEFT_X + 10, doc.y, { width: 330, lineBreak: false });
      doc.text(Number(payslip.exchangeRate).toFixed(2), colAmountX, doc.y, { width: 75, align: 'right', lineBreak: false });
      doc.y += 20;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY);
      doc.text('Total Earnings in PHP', LEFT_X, doc.y, { width: 340, lineBreak: false });
      doc.text(fmtMoney(payslip.totalEarningsPhp), colAmountX, doc.y, { width: 75, align: 'right', lineBreak: false });
      doc.y += 20;
      doc.fillColor('black');
    }

    doc.y = Math.max(doc.y + 40, 720);
    doc.moveTo(LEFT_X, doc.y).lineTo(LEFT_X + CONTENT_WIDTH, doc.y).strokeColor('#e2e8f0').stroke();
    doc.y += 12;
    doc.font('Helvetica-BoldOblique').fontSize(9).fillColor(MUTED)
      .text('This is a system generated payslip', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 12;
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED)
      .text('by Raw Talent Recruitment', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });

    doc.end();
  });
}

module.exports = { buildPayslipPdf };
