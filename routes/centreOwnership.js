const express = require('express');
const router = express.Router();
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const ownership = require('../services/centreOwnershipService');

// Ownership feeds partner credit/bonuses, so every endpoint here is
// super_admin only and anything that writes needs an explicit request.
router.use(requireSuperAdmin);

// What the automatic network-expansion rule WOULD credit right now.
router.get('/network-expansion/preview', async (req, res) => {
  try { res.json(await ownership.previewNetworkExpansion()); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

// Territory handoff proposal (new partner hired in a state). Read-only.
router.get('/handoff/preview', async (req, res) => {
  try {
    const { state, from } = req.query;
    if (!state || !from) return res.status(400).json({ error: 'state and from are required' });
    res.json(await ownership.proposeTerritoryHandoff({ state, fromPartner: from }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Applies a decided keep-list: everything else the partner owns in that state
// reverts to RawTalent.
router.post('/handoff/apply', async (req, res) => {
  try {
    const { state, from, keepCentreKeys } = req.body || {};
    if (!state || !from) return res.status(400).json({ error: 'state and from are required' });
    res.json(await ownership.applyTerritoryHandoff({
      state, fromPartner: from, keepCentreKeys, actorEmail: req.user.email, actorName: req.user.name
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
