const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const payslip = require('../services/payslipService');
const { isFinalApprover } = require('../services/leaveService');

router.use(requireAuth);

// Not a role — Sophia is plain 'admin', Liam/Prince/Yuvraj also hold
// admin/super_admin but aren't payroll admins — so this checks the same
// fixed Sophia/Joy pool used everywhere else for "final approval".
function requireFinalApprover(req, res, next) {
  if (!isFinalApprover(req.user.email)) return res.status(403).json({ error: 'You do not have access to this' });
  next();
}

router.get('/profiles', requireFinalApprover, async (req, res) => {
  try {
    res.json(await payslip.listProfiles());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/profiles/:userEmail', requireFinalApprover, async (req, res) => {
  try {
    const { userName, hourlyRateAud, paysInPhp, bankName, bankAccountName, bankAccountNumber, bankSwiftCode } = req.body;
    res.json(await payslip.upsertProfile({
      userEmail: req.params.userEmail, userName, hourlyRateAud, paysInPhp,
      bankName, bankAccountName, bankAccountNumber, bankSwiftCode, updatedBy: req.user.email
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/eligible', requireFinalApprover, async (req, res) => {
  try {
    if (!req.query.payPeriodStart) return res.status(400).json({ error: 'payPeriodStart is required' });
    res.json(await payslip.listEligibleForPeriod(req.query.payPeriodStart));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One PDF covering every person Ready for the given pay period — see
// services/payslipService.js's buildTeamInvoiceData/generateTeamInvoicePdf.
// Works even before anyone's payslip has actually been generated
// (Ready = both timesheet weeks approved + a payroll profile set up,
// same flag /eligible already returns), using each Ready person's
// already-generated payslip if one exists, live timesheet totals
// otherwise. invoiceNumber/datePaid pass through from the Batch
// Defaults panel so the invoice reflects the same numbers about to be
// used on every payslip in this run. "view" (inline) vs "download"
// (attachment, with the real filename convention) share the same
// builder so they can never drift apart.
router.get('/admin/team-invoice', requireFinalApprover, async (req, res) => {
  try {
    if (!req.query.payPeriodStart) return res.status(400).json({ error: 'payPeriodStart is required' });
    const invoiceNumber = req.query.invoiceNumber ? Number(req.query.invoiceNumber) : undefined;
    const datePaid = req.query.datePaid || undefined;
    const { buffer, filename } = await payslip.generateTeamInvoicePdf(req.query.payPeriodStart, { invoiceNumber, datePaid });
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/suggested-invoice-number', requireFinalApprover, async (req, res) => {
  try {
    res.json({ invoiceNumber: await payslip.suggestedInvoiceNumber() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/prefill', requireFinalApprover, async (req, res) => {
  try {
    const { userEmail, payPeriodStart } = req.query;
    if (!userEmail || !payPeriodStart) return res.status(400).json({ error: 'userEmail and payPeriodStart are required' });
    res.json(await payslip.buildLineItemsFromTimesheets(userEmail, payPeriodStart));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/preview', requireFinalApprover, async (req, res) => {
  try {
    const buffer = await payslip.previewPdf(req.body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="payslip-preview.pdf"');
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/generate', requireFinalApprover, async (req, res) => {
  try {
    const { userEmail, payPeriodStart, invoiceNumber, datePaid, workedDays, lineItems, exchangeRate, totalEarningsPhp } = req.body;
    if (!userEmail || !payPeriodStart || !invoiceNumber || !datePaid) {
      return res.status(400).json({ error: 'userEmail, payPeriodStart, invoiceNumber and datePaid are required' });
    }
    res.json(await payslip.generate({
      userEmail, payPeriodStart, invoiceNumber, datePaid, workedDays, lineItems, exchangeRate, totalEarningsPhp,
      createdBy: req.user.email
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// A draft re-renders live (picks up a bank-details/rate correction made
// to the profile after the draft was generated); a published payslip
// keeps serving its originally-stored PDF unchanged — see
// payslipService.previewStoredPdf for why.
router.get('/admin/preview/:id', requireFinalApprover, async (req, res) => {
  try {
    const row = await payslip.getById(req.params.id);
    if (!row || !row.storage_path) return res.status(404).json({ error: 'Payslip not found' });
    const buffer = row.published_at
      ? await payslip.downloadBuffer(row.storage_path)
      : await payslip.previewStoredPdf(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="payslip.pdf"');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/publish', requireFinalApprover, async (req, res) => {
  try {
    res.json(await payslip.publish(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/unpublish', requireFinalApprover, async (req, res) => {
  try {
    res.json(await payslip.unpublish(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    res.json(await payslip.listAllForAdmin());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Draft-only (deleteDraft itself throws on a published payslip) — gated to
// the same Sophia/Joy final-approver pool as every other payroll action
// here, not requireSuperAdmin. A draft is a correctable mistake either of
// them can make generating it, not a destructive action that needs to be
// restricted beyond the people who already handle payroll.
router.delete('/admin/:id', requireFinalApprover, async (req, res) => {
  try {
    await payslip.deleteDraft(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/mine', async (req, res) => {
  try {
    res.json(await payslip.listMine(req.user.email));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ?inline=1 backs the employee-facing "Preview" button — same
// authorization, same stored bytes, just Content-Disposition: inline so
// the browser's own PDF viewer renders it in a new tab (which already
// has its own download control) instead of forcing a save dialog.
router.get('/:id/download', async (req, res) => {
  try {
    const row = await payslip.authorizeDownload(req.params.id, req.user.email);
    const buffer = await payslip.downloadBuffer(row.storage_path);
    const disposition = req.query.inline ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `${disposition}; filename="Payslip-${row.pay_period_start}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(err.message.includes('access') ? 403 : 404).json({ error: err.message });
  }
});

module.exports = router;
