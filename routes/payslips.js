const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
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

router.get('/admin/preview/:id', requireFinalApprover, async (req, res) => {
  try {
    const row = await payslip.getById(req.params.id);
    if (!row || !row.storage_path) return res.status(404).json({ error: 'Payslip not found' });
    const buffer = await payslip.downloadBuffer(row.storage_path);
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

router.delete('/admin/:id', requireSuperAdmin, async (req, res) => {
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

router.get('/:id/download', async (req, res) => {
  try {
    const row = await payslip.authorizeDownload(req.params.id, req.user.email);
    const buffer = await payslip.downloadBuffer(row.storage_path);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="Payslip-${row.pay_period_start}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(err.message.includes('access') ? 403 : 404).json({ error: err.message });
  }
});

module.exports = router;
