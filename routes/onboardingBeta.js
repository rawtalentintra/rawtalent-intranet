// Onboarding beta — super_admin only until Joy releases it (10 Nov 2026).
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const svc = require('../services/onboardingBetaService');
router.use(requireAuth, requireRole('super_admin'));
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };
router.get('/call-list', wrap(async (req, res) => res.json(await svc.callList({
  centreKey: req.query.centreKey || null, suburb: req.query.suburb || null, radiusKm: Math.min(100, Number(req.query.radiusKm) || 25),
  discipline: req.query.discipline || '', qual: req.query.qual || '' }))));
router.get('/candidates/:id', wrap(async (req, res) => {
  const d = await svc.candidateDetail(req.params.id);
  if (!d) return res.status(404).json({ error: 'Candidate not found' });
  res.json(d);
}));
router.post('/candidates/:id/notes', wrap(async (req, res) => res.status(201).json(await svc.addNote(req.params.id, req.user, req.body && req.body.body))));
module.exports = router;
