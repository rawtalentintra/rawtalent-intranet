const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const jobAdderService = require('../services/jobAdderService');
const candidateService = require('../services/jobAdderCandidateService');
const resumePreviewService = require('../services/resumePreviewService');

// Was router.use(requireAdmin) for the whole file — but the resume-
// attachment route below is what "Resume Link" columns in outreach
// sheets point at, and those sheets get worked by recruiters (regular
// logins, not admin). 2026-09-14: admin-gating that route locked them
// out with "Admin access required" on every click. Search/discovery
// stays admin-only (below); the attachment routes only need a real
// login, same as the team photo proxy (routes/team.js).
router.use(requireAuth);

// The 10 quick-pick centres (with real, resolved lat/lng) plus the
// default qualification keywords — everything the "Find Applicants Near
// Centres" section needs to render its picker before a first search runs.
router.get('/target-centres', requireAdmin, async (req, res) => {
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
router.get('/centres/search', requireAdmin, async (req, res) => {
  try {
    res.json(await candidateService.searchAllCentres(req.query.q));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open job ads (Joy, 2026-09-28: "information on open job ads", same need
// as the earlier JobAdder screenshot she pasted in for a QLD/ACT/NT
// breakdown). First attempt used GET /jobs?active=true (JobAdder's "active
// job" filter per its OpenAPI spec) but this RT account posts ads
// standalone with no underlying Job record behind them — that endpoint
// always returns 0 items here. The real data is GET /jobads: a "state"
// field of Current/Expired/Draft right on the ad itself (confirmed live,
// 2026-09-28: 9 Current out of 2700 total ads). No server-side filter for
// it exists (tried state=/status=/jobAdState= as query params — JobAdder
// silently ignores all three and returns the full unfiltered set, same
// totalCount every time), so this scans every page and filters client-side.
// There's no location field on the ad either — title/reference are the
// only signal, so `state` below is left null rather than guessed; the
// admin UI can show title/reference and let a human read the state off
// them, same as Joy did from her own screenshot.
async function fetchAllJobAds(token) {
  const items = [];
  let offset = 0;
  const limit = 100;
  const HARD_CAP = 5000; // real safety backstop, not a "should never need more than this" guess — this account has 2700+ ads and will only grow
  while (offset < HARD_CAP) {
    const res = await fetch(`${token.apiBaseUrl}/jobads?limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${token.accessToken}` }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`JobAdder /jobads call failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const page = data.items || [];
    items.push(...page);
    offset += limit;
    if (page.length < limit || offset >= (data.totalCount ?? 0)) break;
  }
  return items;
}

router.get('/open-ads', requireAdmin, async (req, res) => {
  try {
    const token = await jobAdderService.getValidAccessToken();
    if (!token) return res.status(400).json({ error: 'JobAdder is not connected.', notConnected: true });
    const all = await fetchAllJobAds(token);
    const open = all
      .filter(a => a.state === 'Current')
      .map(a => ({
        adId: a.adId,
        title: a.title || null,
        reference: a.reference || null,
        summary: a.summary || null,
        owner: a.owner ? `${a.owner.firstName || ''} ${a.owner.lastName || ''}`.trim() : null,
        postAt: a.postAt || null,
        expireAt: a.expireAt || null
      }))
      .sort((x, y) => new Date(y.postAt) - new Date(x.postAt));
    res.json({ scannedCount: all.length, openCount: open.length, items: open });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/search-candidates', requireAdmin, async (req, res) => {
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
router.get('/candidates/:id', requireAdmin, async (req, res) => {
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

router.get('/candidates/:id/attachments', requireAdmin, async (req, res) => {
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
    const filename = req.query.filename ? String(req.query.filename).replace(/["\r\n]/g, '') : 'attachment';
    const disposition = req.query.download ? 'attachment' : 'inline';
    let buf = Buffer.from(await apiRes.arrayBuffer());
    let contentType = apiRes.headers.get('content-type') || 'application/octet-stream';

    // Joy, 2026-09-11: wants an explicit View (opens in a new tab) AND a
    // Download option per file, not just one link. `inline` is what makes
    // a PDF actually render in the new tab instead of prompting to save.
    // Joy, 2026-09-14: browsers have no built-in viewer for Word docs, so a
    // .docx always downloaded regardless of this header — most resumes are
    // .docx. When viewing (not explicitly downloading), render it to a PDF
    // on the fly so it opens inline like any other PDF. Legacy .doc (binary
    // OLE format) isn't supported by the docx->HTML converter this uses —
    // falls back to serving the original file (still a download) for those.
    if (!req.query.download && /\.docx$/i.test(filename)) {
      try {
        buf = await resumePreviewService.convertDocxToPdf(buf);
        contentType = 'application/pdf';
      } catch (convertErr) {
        console.error('docx->PDF preview conversion failed, serving original file:', convertErr.message);
      }
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename.replace(/\.docx$/i, contentType === 'application/pdf' ? '.pdf' : '.docx')}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;
