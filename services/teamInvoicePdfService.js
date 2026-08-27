const path = require('path');
const PDFDocument = require('pdfkit');
const { registerUnicodeFonts, REGULAR, BOLD } = require('./pdfUnicodeFonts');

// Same masthead asset and page geometry as payslipPdfService.js — this
// document is explicitly modeled on that one, not a separate design.
const LOGO_PATH = path.join(__dirname, '../public/images/RawTalent-LOGO.png');
const NAVY = '#0b1d3e';
const ACCENT = '#3d6fff';
const MUTED = '#4f5e7b';
const LEFT_X = 50;
const CONTENT_WIDTH = 495;
const PAGE_W = 595.28;
const ROW_H = 14;

const COL_PAD = 14;
const LEFT_LABEL_W = 88;
const LEFT_VALUE_W = 140;
const RIGHT_X = LEFT_X + COL_PAD + LEFT_LABEL_W + LEFT_VALUE_W + 20;
const RIGHT_LABEL_W = 90;
const RIGHT_VALUE_W = (LEFT_X + CONTENT_WIDTH) - COL_PAD - RIGHT_X - RIGHT_LABEL_W;

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDateLong(d) {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Renders the Team Invoice PDF — one invoice per pay run covering every
// employee paid in it, matching the real external template Joy provided
// (Invoice Number/Reference/PO/Employee/Designation/Address/Bank Details
// header, then a Description/Total Hour/Amount table grouped into
// sections, then one Total Pay in AUD line). Pure function like
// buildPayslipPdf — no DB access — reusing that file's exact page
// geometry, field()/sectionCard() helpers, and pagination approach so the
// two documents read as the same system, not two different ones.
//
// invoice: { invoiceNumber, referenceNo, payPeriodStart, payPeriodEnd,
//   datePaid, sections: [{ label, rows: [{ position, firstName, totalHours, amount }] }],
//   totalAud }
// recipient: { userName, designation, address, bank_name, bank_account_name,
//   bank_account_number, bank_swift_code } — the one person's info this
// invoice is addressed to (see services/payslipService.js's
// TEAM_INVOICE_RECIPIENT_EMAIL for who and why).
function buildTeamInvoicePdf(invoice, recipient) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 50, right: 50, bottom: 40 } });
    registerUnicodeFonts(doc);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header — same logo+divider masthead as the payslip, but the
    // title block itself is plain bold black stacked lines (Team Invoice
    // / Raw Talent Recruitment / address), matching the real external
    // template exactly rather than the payslip's colored-subtitle style. ──
    doc.y = 32;
    try { doc.image(LOGO_PATH, (PAGE_W - 115) / 2, doc.y, { width: 115 }); doc.y += 38; } catch { doc.y += 8; }
    doc.moveTo(LEFT_X, doc.y).lineTo(LEFT_X + CONTENT_WIDTH, doc.y).lineWidth(1).strokeColor('#e2e8f0').stroke();
    doc.y += 18;

    doc.font(BOLD).fontSize(12).fillColor(NAVY)
      .text('Team Invoice', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 15;
    doc.font(BOLD).fontSize(11).fillColor(NAVY)
      .text('Raw Talent Recruitment', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 14;
    doc.font(BOLD).fontSize(9.5).fillColor(NAVY)
      .text('Level 5|111, Cecil St, South Melbourne VIC 3205, Australia', LEFT_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.y += 22;

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
    function sectionCard(y, height, label) {
      doc.roundedRect(LEFT_X, y, CONTENT_WIDTH, height, 6).fill('#eff6ff');
      doc.roundedRect(LEFT_X, y, 4, height, 2).fill(ACCENT);
      doc.font(BOLD).fontSize(7.5).fillColor(ACCENT)
        .text(label.toUpperCase(), LEFT_X + COL_PAD, y + 9, { characterSpacing: 0.5 });
    }

    // Invoice Number/Reference/Pay Period/Date Paid on the left; the one
    // named recipient's Employee/Designation/Address on the right — same
    // two-column shape as the real template.
    function layoutInfoBlock(top, measure) {
      const bodyTop = top + 22;
      let leftY = bodyTop;
      let rightY = bodyTop;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Invoice No.', String(invoice.invoiceNumber).padStart(4, '0'), LEFT_VALUE_W, LEFT_LABEL_W, measure) + 3;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Reference/PO', invoice.referenceNo, LEFT_VALUE_W, LEFT_LABEL_W, measure) + 3;
      leftY += field(LEFT_X + COL_PAD, leftY, 'Date Paid', fmtDateLong(invoice.datePaid), LEFT_VALUE_W, LEFT_LABEL_W, measure);

      rightY += field(RIGHT_X, rightY, 'Employee', recipient.userName || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 3;
      rightY += field(RIGHT_X, rightY, 'Designation', recipient.designation || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 3;
      rightY += field(RIGHT_X, rightY, 'Address', recipient.address || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure);

      const columnsBottom = Math.max(leftY, rightY) + 6;
      const ppLabelW = 85;
      if (!measure) {
        doc.font(REGULAR).fontSize(9).fillColor(MUTED)
          .text('Pay Period', LEFT_X + COL_PAD, columnsBottom, { width: ppLabelW, lineBreak: false });
        doc.font(REGULAR).fontSize(9).fillColor(NAVY)
          .text(`${fmtDateLong(invoice.payPeriodStart)}  –  ${fmtDateLong(invoice.payPeriodEnd)}`, LEFT_X + COL_PAD + ppLabelW, columnsBottom, { width: CONTENT_WIDTH - 2 * COL_PAD - ppLabelW, lineBreak: false });
      }
      return (columnsBottom + ROW_H + 8) - top;
    }

    // Swift Code only renders when there's an actual value on file — the
    // stored placeholder is a literal "-" for Wise accounts (no SWIFT
    // needed), and an always-empty field on a real financial document
    // reads as broken/missing data rather than genuinely not applicable.
    const hasSwiftCode = !!(recipient.bank_swift_code && recipient.bank_swift_code.trim() && recipient.bank_swift_code.trim() !== '-');
    const bankColGap = RIGHT_X - LEFT_X - COL_PAD - LEFT_LABEL_W - LEFT_VALUE_W;
    function layoutBankBlock(top, measure) {
      const bodyTop = top + 22;
      let bankY = bodyTop;
      bankY += field(LEFT_X + COL_PAD, bankY, 'Bank Name', recipient.bank_name || '-', LEFT_VALUE_W + bankColGap, LEFT_LABEL_W, measure) + 3;
      bankY += field(LEFT_X + COL_PAD, bankY, 'Account Name', recipient.bank_account_name || '-', LEFT_VALUE_W + bankColGap, LEFT_LABEL_W, measure) + 3;
      let bankY2 = bodyTop;
      bankY2 += field(RIGHT_X, bankY2, 'Account No.', recipient.bank_account_number || '-', RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 3;
      if (hasSwiftCode) bankY2 += field(RIGHT_X, bankY2, 'Swift Code', recipient.bank_swift_code, RIGHT_VALUE_W, RIGHT_LABEL_W, measure) + 3;
      return (Math.max(bankY, bankY2) + 6) - top;
    }

    const infoTop = doc.y;
    const infoHeight = layoutInfoBlock(infoTop, true);
    sectionCard(infoTop, infoHeight, 'Invoice Details');
    layoutInfoBlock(infoTop, false);
    doc.y = infoTop + infoHeight + 12;

    const bankTop = doc.y;
    const bankHeight = layoutBankBlock(bankTop, true);
    sectionCard(bankTop, bankHeight, 'Bank Details');
    layoutBankBlock(bankTop, false);
    doc.y = bankTop + bankHeight + 16;

    // ── Description / Total Hour / Amount table, grouped into sections
    // (e.g. "Managements" / "Consultants" — see
    // payslipService.buildTeamInvoiceSections for how a row's position
    // decides which section it lands in). Each row shows the person's
    // position in one sub-column and "- FirstName" in the next, exactly
    // matching the real template's two-part Description cell. ──────────
    const colNameX = LEFT_X + 160;
    const colHourX = LEFT_X + 330;
    const colAmountX = LEFT_X + 410;

    function drawTableHeader() {
      doc.roundedRect(LEFT_X, doc.y, CONTENT_WIDTH, 20, 4).fill(NAVY);
      const hy = doc.y + 6;
      doc.fillColor('white').font(BOLD).fontSize(9);
      doc.text('Description', LEFT_X + 10, hy, { width: 300, lineBreak: false });
      doc.text('Total Hour', colHourX, hy, { width: 70, align: 'right', lineBreak: false });
      doc.text('Amount', colAmountX, hy, { width: 75, align: 'right', lineBreak: false });
      doc.y += 24;
      doc.fillColor('black').font(REGULAR).fontSize(9);
    }
    function drawSectionBand(label) {
      if (doc.y > 750) { doc.addPage(); doc.y = 40; drawTableHeader(); }
      doc.rect(LEFT_X, doc.y, CONTENT_WIDTH, ROW_H + 4).fill('#f3f4f6');
      doc.font(BOLD).fontSize(9).fillColor(NAVY)
        .text(label, LEFT_X + 10, doc.y + 4, { width: 300, lineBreak: false });
      doc.y += ROW_H + 8;
      doc.font(REGULAR).fontSize(9).fillColor(NAVY);
    }
    drawTableHeader();

    for (const section of invoice.sections) {
      if (!section.rows.length) continue;
      drawSectionBand(section.label);
      for (const row of section.rows) {
        if (doc.y > 760) { doc.addPage(); doc.y = 40; drawTableHeader(); }
        const rowY = doc.y;
        doc.font(REGULAR).fontSize(9).fillColor(NAVY);
        doc.text(row.position || '-', LEFT_X + 10, rowY, { width: 145, lineBreak: false });
        doc.text(`- ${row.firstName}`, colNameX, rowY, { width: 165, lineBreak: false });
        doc.text(Number(row.totalHours).toFixed(2), colHourX, rowY, { width: 70, align: 'right', lineBreak: false });
        doc.text(fmtMoney(row.amount), colAmountX, rowY, { width: 75, align: 'right', lineBreak: false });
        doc.y = rowY + ROW_H;
      }
      doc.y += 8;
    }

    if (doc.y > 750) { doc.addPage(); doc.y = 40; }
    doc.y += 8;
    // Same fix as payslipPdfService.js's Total Earnings line once needed —
    // doc.y has to be captured into a local ONCE and reused for both the
    // label and the amount on this row; reading doc.y twice (once per
    // .text() call) let pdfkit's cursor-advance side effect push the two
    // apart onto visibly different lines.
    const totalRowY = doc.y;
    doc.rect(LEFT_X, totalRowY, CONTENT_WIDTH, ROW_H + 8).fill('#f3f4f6');
    doc.font(BOLD).fontSize(10).fillColor(NAVY)
      .text('Total Pay in AUD', LEFT_X + 10, totalRowY + 5, { width: 340, lineBreak: false });
    doc.text(fmtMoney(invoice.totalAud), colAmountX, totalRowY + 5, { width: 75, align: 'right', lineBreak: false });
    doc.y = totalRowY + ROW_H + 8;

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

module.exports = { buildTeamInvoicePdf };
