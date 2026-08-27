const path = require('path');
const PDFDocument = require('pdfkit');
const { registerUnicodeFonts, REGULAR, BOLD } = require('./pdfUnicodeFonts');

const LOGO_PATH = path.join(__dirname, '../public/images/RawTalent-LOGO.png');
const NAVY = '#0b1d3e';
const ACCENT = '#3d6fff'; // matches the app's --orange (actually blue) accent — the one accent color used everywhere on this document now
const MUTED = '#4f5e7b';
const LEFT_X = 50;
const CONTENT_WIDTH = 495;
const PAGE_W = 595.28;
const ROW_H = 14;

// Two-column geometry for the info/bank cards — computed so neither
// column's value area can overflow the page margin (an earlier version
// put the right column's value box past the printable width, which is
// what made the Employee/Bank fields look misaligned rather than actually
// being a text-wrapping quirk).
const COL_PAD = 14; // inner padding of each card
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
// zero-write "preview" flow from the same code path. Deliberately tight
// on vertical spacing throughout (every gap below was hand-tuned, not
// arbitrary) — a real payslip with a PHP conversion block and a
// two/three-line wrapped address has to still fit on one page, and
// pdfkit will silently start a second page the moment content runs past
// the bottom margin.
//
// Every row is drawn with an explicitly-tracked y coordinate rather than
// relying on pdfkit's implicit cursor advance — text() moves doc.y as a
// side effect by default, which silently desyncs a multi-column layout
// (label at one x, value at another x, both meant to sit on the same
// row) the moment any call in between reads doc.y again. Every row here
// captures its y into a local const ONCE and reuses that same value for
// every column on that row — the "Total Earnings" line in an earlier
// version skipped this (read doc.y twice, once per column) and the
// amount silently landed a line below its own label as a result.
//
// payslip: { invoiceNumber, referenceNo, userName, designation, address,
//   payPeriodStart, payPeriodEnd, datePaid, workedDays, lineItems, totalEarningsAud,
//   exchangeRate, totalEarningsPhp, paysInPhp }
// profile: { bankName, bankAccountName, bankAccountNumber, bankSwiftCode }
function buildPayslipPdf(payslip, profile) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 50, right: 50, bottom: 40 } });
    registerUnicodeFonts(doc);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header: logo, a rule marking it off as its own masthead band,
    // then the title — company name/address sit close underneath the
    // title rather than floating with a lot of dead air. ──────────────
    doc.y = 32;
    try { doc.image(LOGO_PATH, (PAGE_W - 115) / 2, doc.y, { width: 115 }); doc.y += 38; } catch { doc.y += 8; }
    doc.moveTo(LEFT_X, doc.y).lineTo(LEFT_X + CONTENT_WIDTH, doc.y).lineWidth(1).strokeColor('#e2e8f0').stroke();
    doc.y += 16;

    doc.font(BOLD).fontSize(20).fillColor(NAVY)
      .text('PAYSLIP', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center', characterSpacing: 3 });
    doc.y += 22;
    doc.font(BOLD).fontSize(10).fillColor(ACCENT)
      .text('RawTalent Recruitment', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center', characterSpacing: 0.5 });
    doc.y += 13;
    doc.font(REGULAR).fontSize(8.5).fillColor(MUTED)
      .text('Level 5|111, Cecil St, South Melbourne VIC 3205, Australia', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 20;

    // label/value pair at an explicit (x,y) — returns the row height
    // taken (at least ROW_H, more if the value wraps). measure=true only
    // computes the height (pdfkit's heightOfString has no drawing side
    // effect) without painting anything — needed because a card's tinted
    // background has to be drawn BEFORE its text, but the card's height
    // isn't known until after laying out that same text. Drawing the
    // fill after the text (an earlier version of this file did that)
    // just paints over and hides everything already written.
    function field(x, y, label, value, valueWidth, labelWidth, measure) {
      const text = String(value);
      const h = Math.max(ROW_H, doc.heightOfString(text, { width: valueWidth }));
      if (measure) return h;
      doc.font(REGULAR).fontSize(9).fillColor(MUTED);
      doc.text(label, x, y, { width: labelWidth, lineBreak: false });
      doc.font(REGULAR).fontSize(9).fillColor(NAVY);
      doc.text(text, x + labelWidth, y, { width: valueWidth });
      return h;
    }

    // A light blue card behind a block of fields, with a small accent
    // section label riding on its top edge — one consistent accent color
    // for every highlighted section on the document, not a different
    // color per card.
    function sectionCard(y, height, label) {
      doc.roundedRect(LEFT_X, y, CONTENT_WIDTH, height, 6).fill('#eff6ff');
      doc.roundedRect(LEFT_X, y, 4, height, 2).fill(ACCENT);
      doc.font(BOLD).fontSize(7.5).fillColor(ACCENT)
        .text(label.toUpperCase(), LEFT_X + COL_PAD, y + 9, { characterSpacing: 0.5 });
    }

    // Lays out the Invoice/Pay-Period/Employee block; measure=true skips
    // all drawing and just returns the block's total height so the card
    // background can be sized and painted first.
    function layoutInfoBlock(top, measure) {
      const bodyTop = top + 22;
      let leftY = bodyTop;
      let rightY = bodyTop;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Invoice No.', String(payslip.invoiceNumber).padStart(4, '0'), LEFT_VALUE_W, LEFT_LABEL_W, measure) + 3;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Reference/PO', payslip.referenceNo, LEFT_VALUE_W, LEFT_LABEL_W, measure) + 3;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Date Paid', fmtDateLong(payslip.datePaid), LEFT_VALUE_W, LEFT_LABEL_W, measure) + 3;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Worked Days', String(payslip.workedDays), LEFT_VALUE_W, LEFT_LABEL_W, measure);

      rightY += field(RIGHT_X, rightY, 'Employee', payslip.userName, RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 3;
      rightY += field(RIGHT_X, rightY, 'Designation', payslip.designation || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 3;
      rightY += field(RIGHT_X, rightY, 'Address', payslip.address || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure);

      // Pay Period gets its own full-width row below both columns — it's
      // a long date range and cramming it into the narrow left column
      // wrapped it onto two lines and threw the columns' rhythm off. One
      // line, full width, is what actually reads as "aligned."
      const columnsBottom = Math.max(leftY, rightY) + 6;
      const ppLabelW = 85;
      if (!measure) {
        doc.font(REGULAR).fontSize(9).fillColor(MUTED)
          .text('Pay Period', LEFT_X + COL_PAD, columnsBottom, { width: ppLabelW, lineBreak: false });
        doc.font(REGULAR).fontSize(9).fillColor(NAVY)
          .text(`${fmtDateLong(payslip.payPeriodStart)}  –  ${fmtDateLong(payslip.payPeriodEnd)}`, LEFT_X + COL_PAD + ppLabelW, columnsBottom, { width: CONTENT_WIDTH - 2 * COL_PAD - ppLabelW, lineBreak: false });
      }
      return (columnsBottom + ROW_H + 8) - top;
    }

    const bankColGap = RIGHT_X - LEFT_X - COL_PAD - LEFT_LABEL_W - LEFT_VALUE_W;
    // Lays out the Bank Details block the same measure/draw way.
    function layoutBankBlock(top, measure) {
      const bodyTop = top + 22;
      let bankY = bodyTop;
      bankY += field(LEFT_X + COL_PAD, bankY, 'Bank Name', profile.bank_name || '-', LEFT_VALUE_W + bankColGap, LEFT_LABEL_W, measure) + 3;
      bankY += field(LEFT_X + COL_PAD, bankY, 'Account Name', profile.bank_account_name || '-', LEFT_VALUE_W + bankColGap, LEFT_LABEL_W, measure) + 3;
      let bankY2 = bodyTop;
      bankY2 += field(RIGHT_X, bankY2, 'Account No.', profile.bank_account_number || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 3;
      bankY2 += field(RIGHT_X, bankY2, 'Swift Code', profile.bank_swift_code || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 3;
      return (Math.max(bankY, bankY2) + 6) - top;
    }

    // ── Invoice / Pay Period / Employee card ──────────────────────
    const infoTop = doc.y;
    const infoHeight = layoutInfoBlock(infoTop, true);
    sectionCard(infoTop, infoHeight, 'Payslip Details');
    layoutInfoBlock(infoTop, false);
    doc.y = infoTop + infoHeight + 12;

    // ── Bank Details card — same accent as above; it's a separate card
    // because it's a separate, more sensitive fact set, not because it
    // needs a different color to say so. ──────────────────────────────
    const bankTop = doc.y;
    const bankHeight = layoutBankBlock(bankTop, true);
    sectionCard(bankTop, bankHeight, 'Bank Details');
    layoutBankBlock(bankTop, false);
    doc.y = bankTop + bankHeight + 16;

    // ── Shift Details table ────────────────────────────────────────
    const colHourX = LEFT_X + 330;
    const colAmountX = LEFT_X + 410;

    function drawTableHeader(label, showHourColumn) {
      doc.roundedRect(LEFT_X, doc.y, CONTENT_WIDTH, 20, 4).fill(NAVY);
      const hy = doc.y + 6;
      doc.fillColor('white').font(BOLD).fontSize(9);
      doc.text(label, LEFT_X + 10, hy, { width: 300, lineBreak: false });
      if (showHourColumn) doc.text('Total Hour', colHourX, hy, { width: 70, align: 'right', lineBreak: false });
      doc.text('Amount', colAmountX, hy, { width: 75, align: 'right', lineBreak: false });
      doc.y += 24;
      doc.fillColor('black').font(REGULAR).fontSize(9);
    }
    drawTableHeader('Shift Details', true);

    // Prints groupLabel only when it changes from the previous row —
    // reproduces grouped shift rows (e.g. "Week 1: …") printed once with
    // dated sub-rows sitting under it, not repeated per row.
    let prevGroup = null;
    for (const item of payslip.lineItems) {
      if (doc.y > 760) { doc.addPage(); doc.y = 40; drawTableHeader('Shift Details', true); prevGroup = null; }
      const rowY = doc.y;
      doc.font(REGULAR).fontSize(9).fillColor(NAVY);
      const showGroup = item.groupLabel && item.groupLabel !== prevGroup;
      if (showGroup) doc.text(item.groupLabel, LEFT_X + 10, rowY, { width: 145, lineBreak: false });
      if (item.label) doc.text(item.label, LEFT_X + 160, rowY, { width: 165, lineBreak: false });
      doc.text(Number(item.hours).toFixed(2), colHourX, rowY, { width: 70, align: 'right', lineBreak: false });
      doc.text(fmtMoney(item.amount), colAmountX, rowY, { width: 75, align: 'right', lineBreak: false });
      doc.y = rowY + ROW_H;
      prevGroup = item.groupLabel || prevGroup;
    }

    doc.moveTo(LEFT_X, doc.y + 4).lineTo(LEFT_X + CONTENT_WIDTH, doc.y + 4).strokeColor('#d1d5db').stroke();
    doc.y += 12;

    // Shared by both the AUD and PHP totals so they can never drift apart
    // in size/weight — one font size for "this is a total" everywhere it
    // appears on the document, not set independently at each call site.
    const TOTAL_FONT_SIZE = 10.5;
    function drawTotalLine(label, amount) {
      const y = doc.y;
      doc.font(BOLD).fontSize(TOTAL_FONT_SIZE).fillColor(NAVY);
      doc.text(label, LEFT_X, y, { width: 340, lineBreak: false });
      doc.text(fmtMoney(amount), colAmountX, y, { width: 75, align: 'right', lineBreak: false });
      doc.y = y + 20;
    }

    drawTotalLine('Total Earnings in AUD', payslip.totalEarningsAud);

    // No separate header/divider for the PHP conversion — it's just two
    // more rows directly under Total Earnings in AUD, same as the request:
    // AUD total, then exchange rate, then PHP total, nothing else.
    if (payslip.paysInPhp) {
      {
        const rateY = doc.y;
        doc.font(REGULAR).fontSize(9).fillColor(NAVY);
        doc.text('Currency Exchange Rate', LEFT_X, rateY, { width: 340, lineBreak: false });
        doc.text(Number(payslip.exchangeRate).toFixed(2), colAmountX, rateY, { width: 75, align: 'right', lineBreak: false });
        doc.y = rateY + 16;
      }
      drawTotalLine('Total Earnings in PHP', payslip.totalEarningsPhp);
    }

    // Footer is pinned near the actual bottom of the page rather than
    // trailing right after whatever content happens to end above it —
    // falls back to right-after-content only if a long payslip would
    // otherwise run into it.
    doc.y = Math.max(doc.y + 16, 750);
    doc.moveTo(LEFT_X, doc.y).lineTo(LEFT_X + CONTENT_WIDTH, doc.y).strokeColor('#e2e8f0').stroke();
    doc.y += 10;
    doc.font('Helvetica-BoldOblique').fontSize(8.5).fillColor(MUTED)
      .text('This is a system generated payslip', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 11;
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED)
      .text('by Raw Talent Recruitment', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });

    doc.end();
  });
}

module.exports = { buildPayslipPdf };
