// Sophia's approval page for SMS sends to more than 10 people (Joy, 25 Nov 2026).
// Linked from the Slack DM in services/educatorTextService.js (notifyApprover).
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const svc = require('../services/educatorTextService');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.get('/:id', requireAuth, async (req, res) => {
  const can = svc.isApprover(req.user) || req.user.role === 'super_admin';
  const db = getDb();
  const b = (await db.execute({ sql: 'SELECT * FROM sms_batches WHERE id = ?', args: [Number(req.params.id) || 0] })).rows[0];
  if (!b) return res.status(404).send('Not found');
  const msgs = (await db.execute({ sql: `SELECT educator_name, phone, body, status FROM sms_messages WHERE batch_id = ? ORDER BY educator_name`, args: [b.id] })).rows;
  const state = { pending: '⏳ Waiting for approval', approved: `✅ Approved by ${esc(b.approved_by)}`, rejected: `❌ Not approved (${esc(b.approved_by)})` }[b.approval_status] || 'No approval needed';
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SMS approval</title>
<body style="font-family:Inter,system-ui,sans-serif;background:#f5f7fb;margin:0;padding:16px;color:#0f1f3d">
<div style="max-width:720px;margin:auto;background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 10px rgba(15,31,61,.08)">
<h2 style="margin:0 0 4px">SMS approval</h2>
<div style="color:#5b6b85;font-size:14px;margin-bottom:14px">${esc(b.sent_by_name)} · ${b.recipient_count} people · ${esc(b.audience_note || '')}</div>
<div style="font-weight:600;margin-bottom:6px">${state}</div>
<div style="background:#eef5ff;border-radius:10px;padding:12px;white-space:pre-wrap;margin-bottom:14px">${esc(b.body)}</div>
${can && b.approval_status === 'pending' ? `<form method="post" style="display:flex;gap:8px;margin-bottom:16px">
<button name="d" value="approve" style="background:#1d4ed8;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer">Approve and send</button>
<button name="d" value="reject" style="background:#fff;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer">Don't send</button></form>`
  : !can ? '<p style="color:#5b6b85">Only Sophia can approve this.</p>' : ''}
<details><summary style="cursor:pointer;font-weight:600">Recipients (${msgs.length})</summary>
<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:8px">${msgs.map(m => `<tr style="border-top:1px solid #eef1f6"><td style="padding:5px">${esc(m.educator_name)}</td><td>${esc(m.phone)}</td><td style="color:#5b6b85">${esc(m.status)}</td></tr>`).join('')}</table></details>
<p style="margin-top:16px"><a href="/?tab=texts">Open SMS</a></p></div></body>`);
});

router.post('/:id', requireAuth, express.urlencoded({ extended: false }), async (req, res) => {
  try {
    await svc.decideBatch(Number(req.params.id) || 0, req.user, req.body.d === 'approve');
    res.redirect(`/sms-approval/${Number(req.params.id)}`);
  } catch (e) { res.status(e.status || 500).send(esc(e.message)); }
});

module.exports = router;
