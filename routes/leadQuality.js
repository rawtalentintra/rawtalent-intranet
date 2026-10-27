// Lead quality endpoints (Liam, 26 Oct 2026): Lead Wash queue, lead/centre
// group category, funnel stages. See services/leadWashService.js,
// leadCategoryService.js and leadFunnelService.js.
const express = require('express');
const router = express.Router();
const wash = require('../services/leadWashService');
const category = require('../services/leadCategoryService');
const funnel = require('../services/leadFunnelService');

const LEADS_ROLES = ['admin', 'super_admin', 'qa_view', 'workforce_partner'];
const signedIn = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not signed in' }));
const canWash = (req, res, next) => (wash.canWash(req.user) ? next() : res.status(403).json({ error: 'Lead Wash isn\'t switched on for your account' }));
// Category: anyone who can see leads (incl. WFPs) or wash them.
const canCategorise = (req, res, next) => (LEADS_ROLES.includes(req.user?.role) || wash.canWash(req.user) ? next() : res.status(403).json({ error: 'Not allowed' }));
const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });

router.use(signedIn);

router.get('/options', (req, res) => res.json({ serviceTypes: category.SERVICE_TYPES, groups: category.GROUPS, short: category.SHORT, wash: wash.OPTIONS, funnelStages: funnel.STAGES, canWash: wash.canWash(req.user) }));

router.get('/wash/queue', canWash, async (req, res) => {
  try {
    res.json(await wash.queue({
      state: String(req.query.state || '').toUpperCase() || null, service: req.query.service || null, group: req.query.group || null,
      status: req.query.status || 'unwashed', bigFirst: req.query.bigFirst !== '0'
    }));
  } catch (err) { fail(res, err); }
});
router.get('/wash/:leadId/history', canWash, async (req, res) => { try { res.json(await wash.history(req.params.leadId)); } catch (err) { fail(res, err); } });
router.post('/wash/:leadId', canWash, async (req, res) => { try { res.status(201).json(await wash.recordWash(req.params.leadId, req.body || {}, req.user)); } catch (err) { fail(res, err); } });

router.put('/category/lead/:leadId', canCategorise, async (req, res) => {
  try { res.json(await category.setLeadCategory(req.params.leadId, req.body || {}, req.user)); } catch (err) { fail(res, err); }
});
router.put('/category/centre/:centreKey', canCategorise, async (req, res) => {
  try { res.json(await category.setCentreCategory(req.params.centreKey, req.body || {}, req.user)); } catch (err) { fail(res, err); }
});
router.get('/category/centre/:centreKey', canCategorise, async (req, res) => {
  try {
    const row = (await require('../db/database').getDb().execute({ sql: 'SELECT service_type, group_category, set_by, set_at FROM centre_categories WHERE centre_key = ?', args: [req.params.centreKey] })).rows[0];
    res.json(row ? { ...row, label: category.label(row.service_type, row.group_category) } : null);
  } catch (err) { fail(res, err); }
});

router.get('/funnel', canCategorise, async (req, res) => {
  try { res.json(await funnel.computeStages({ fresh: req.query.fresh === '1' })); } catch (err) { fail(res, err); }
});

module.exports = router;
