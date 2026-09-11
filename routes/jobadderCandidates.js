const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/authMiddleware');
const jobAdderService = require('../services/jobAdderService');
const candidateService = require('../services/jobAdderCandidateService');

router.use(requireAdmin);

// The 10 quick-pick centres (with real, resolved lat/lng) plus the
// default qualification keywords — everything the "Find Applicants Near
// Centres" section needs to render its picker before a first search runs.
router.get('/target-centres', async (req, res) => {
  try {
    const centres = await candidateService.resolveQuickPickCentres();
    res.json({ centres, defaultKeywords: candidateService.DEFAULT_KEYWORDS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// General "add another centre" picker — any RT centre, not just the 10
// quick-picks, same "type at least 2 characters" shape as other search-
// as-you-type inputs in this app.
router.get('/centres/search', async (req, res) => {
  try {
    res.json(await candidateService.searchAllCentres(req.query.q));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/search-candidates', async (req, res) => {
  try {
    const centreKeys = (req.query.centreKeys || '').split(',').map(s => s.trim()).filter(Boolean);
    const radiusKm = Number(req.query.radiusKm) || 15;
    const keywords = req.query.keywords != null ? req.query.keywords : candidateService.DEFAULT_KEYWORDS;
    const data = await candidateService.searchCandidatesNearCentres({ centreKeys, keywords, radiusKm });
    res.json(data);
  } catch (err) {
    if (err.notConnected) return res.status(400).json({ error: err.message, notConnected: true });
    if (err.badRequest) return res.status(400).json({ error: err.message });
    res.status(502).json({ error: err.message });
  }
});

// Full candidate detail (education/employment history/etc.) — for the
// "see... all their info" drill-down, not shown in the compact list table.
router.get('/candidates/:id', async (req, res) => {
  try {
    const token = await jobAdderService.getValidAccessToken();
    if (!token) return res.status(400).json({ error: 'JobAdder is not connected.' });
    const apiRes = await fetch(`${token.apiBaseUrl}/candidates/${encodeURIComponent(req.params.id)}`, {
      headers: { Authorization: `Bearer ${token.accessToken}` }
    });
    if (!apiRes.ok) {
      const body = await apiRes.text().catch(() => '');
      return res.status(apiRes.status === 404 ? 404 : 502).json({ error: body.slice(0, 300) || 'Failed to load candidate' });
    }
    res.json(await apiRes.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/candidates/:id/attachments', async (req, res) => {
  try {
    const token = await jobAdderService.getValidAccessToken();
    if (!token) return res.status(400).json({ error: 'JobAdder is not connected.' });
    const apiRes = await fetch(`${token.apiBaseUrl}/candidates/${encodeURIComponent(req.params.id)}/attachments`, {
      headers: { Authorization: `Bearer ${token.accessToken}` }
    });
    if (!apiRes.ok) return res.status(502).json({ error: 'Failed to load attachments' });
    const data = await apiRes.json();
    res.json(data.items || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streams the real file (resume/cover letter/etc.) straight through — the
// browser never sees the JobAdder access token, only this app's own
// session cookie, same "server holds the real credential" shape as every
// other proxied download in this app.
router.get('/candidates/:id/attachments/:attachmentId', async (req, res) => {
  try {
    const token = await jobAdderService.getValidAccessToken();
    if (!token) return res.status(400).json({ error: 'JobAdder is not connected.' });
    const apiRes = await fetch(`${token.apiBaseUrl}/candidates/${encodeURIComponent(req.params.id)}/attachments/${encodeURIComponent(req.params.attachmentId)}`, {
      headers: { Authorization: `Bearer ${token.accessToken}` }
    });
    if (!apiRes.ok) return res.status(apiRes.status === 404 ? 404 : 502).send('Failed to load attachment');
    res.setHeader('Content-Type', apiRes.headers.get('content-type') || 'application/octet-stream');
    const filename = req.query.filename ? String(req.query.filename).replace(/["\r\n]/g, '') : 'attachment';
    // Joy, 2026-09-11: wants an explicit View (opens in a new tab) AND a
    // Download option per file, not just one link. `inline` is what makes
    // a PDF actually render in the new tab instead of prompting to save —
    // `attachment` (only when ?download=1 is passed) forces the save
    // dialog instead. A format the browser has no native viewer for (e.g.
    // .docx) still ends up downloading either way once clicked — that's a
    // browser limitation, not something this header controls.
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
    const buf = Buffer.from(await apiRes.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;
