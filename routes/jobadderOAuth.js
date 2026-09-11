const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAdmin } = require('../middleware/authMiddleware');
const jobAdderService = require('../services/jobAdderService');

// The one step that can't be automated — JobAdder requires a real admin
// user (on JobAdder's side, "admin user or user with Grant API Access")
// to log into JobAdder and approve access on their own consent screen.
// This just sends them there with the right params; GET /callback below
// is where the actual token exchange happens once they're back.
router.get('/', requireAdmin, (req, res) => {
  if (!jobAdderService.isConfigured()) {
    return res.status(500).send('JobAdder integration is not configured — JOBADDER_CLIENT_ID/JOBADDER_CLIENT_SECRET are missing from this environment.');
  }
  // Random per-attempt state, checked on the way back — same CSRF purpose
  // as routes/auth.js's Google OAuth flow, just via the session instead of
  // the `state` round-trip Google's redirect already carries for us there.
  const state = crypto.randomBytes(16).toString('hex');
  req.session.jobAdderOAuthState = state;
  res.redirect(jobAdderService.buildAuthorizeUrl(state));
});

router.get('/callback', requireAdmin, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`JobAdder authorization was not granted (${error}). Go back to Settings and try Connect JobAdder again.`);
  }
  if (!code || !state || state !== req.session.jobAdderOAuthState) {
    return res.status(400).send('This authorization link has expired or was already used — go back to Settings and click Connect JobAdder again.');
  }
  delete req.session.jobAdderOAuthState;
  try {
    await jobAdderService.exchangeCodeForToken(code, req.user.email);
    res.redirect('/admin?jobadder=connected');
  } catch (err) {
    res.status(500).send(`Failed to connect JobAdder: ${err.message}`);
  }
});

// Whether the connection is live right now, and who last completed it —
// deliberately no tokens in this response, just enough to render a status
// line ("Connected as ... on 11 Sept 2026") without exposing anything
// sensitive to the browser.
router.get('/status', requireAdmin, async (req, res) => {
  try {
    res.json(await jobAdderService.connectionStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real proof, not just "tokens exist" — actually calls the JobAdder API
// and returns a small real sample, so a 200 here genuinely means data
// access works, not just that a token is sitting in the DB unused.
router.get('/test', requireAdmin, async (req, res) => {
  try {
    const token = await jobAdderService.getValidAccessToken();
    if (!token) return res.status(400).json({ error: 'Not connected yet — visit /auth/jobadder first to authorize.' });
    const apiRes = await fetch(`${token.apiBaseUrl}/candidates?limit=3`, {
      headers: { Authorization: `Bearer ${token.accessToken}` }
    });
    if (!apiRes.ok) {
      const body = await apiRes.text().catch(() => '');
      return res.status(502).json({ error: `JobAdder API call failed (${apiRes.status}): ${body.slice(0, 300)}` });
    }
    const data = await apiRes.json();
    const items = Array.isArray(data.items) ? data.items : [];
    res.json({
      success: true,
      totalCount: data.totalCount ?? null,
      sample: items.map(c => ({ candidateId: c.candidateId, name: `${c.firstName || ''} ${c.lastName || ''}`.trim() }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
