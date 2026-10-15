const express = require('express');
const router = express.Router();
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const mcpTokens = require('../services/mcpTokenService');

// Regular session auth (cookie) — this is the Settings UI managing
// tokens for whoever's actually logged in right now, not the MCP
// protocol endpoint itself (see routes/mcp.js, which uses the token as
// its own bearer-auth instead of a session).
// super_admin only for now (Joy 2026-08-28) — this is a brand new,
// still-experimental feature; requireAuth alone would let any logged-in
// role generate their own token today. Widen this (or make it a
// per-person grant, matching requireTrainingBuilder's pattern) if MCP
// access is ever meant to reach past just her.
// super_admin plus Liam (Joy, 2026-10-15) — the same accounts the /mcp endpoint
// itself allows, so Liam can make his own token for apps that can't do the
// OAuth sign-in (e.g. the Codex app). Tokens are only ever for the signed-in user.
router.use((req, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (!require('../services/mcpTokenService').canUseMcp(req.user.email, req.user.role)) return res.status(403).json({ error: 'Super admin access required' });
  next();
});

router.get('/', async (req, res) => {
  try {
    res.json(await mcpTokens.listTokens(req.user.email));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const label = (req.body.label || '').trim() || null;
    const token = await mcpTokens.generateToken(req.user.email, label);
    res.json({ token }); // the only time this value is ever returned
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await mcpTokens.revokeToken(req.params.id, req.user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
