const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const jobAdderService = require('../services/jobAdderService');
const candidateService = require('../services/jobAdderCandidateService');
const resumePreviewService = require('../services/resumePreviewService');
const { getDb } = require('../db/database');

const VALID_CLASSIFICATIONS = new Set(['not_reviewed', 'move_forward', 'not_a_fit']);

// Same "last 9 digits" comparison as services/educatorSearchService.js
// (0417225760 / +61417225760 / 417225760 all match) — duplicated rather
// than imported since that service's searchEducators() does one query per
// call and a fuzzy name fallback we don't want here; this is a single
// batched exact-phone lookup across every applicant on the ad at once.
function last9Digits(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-9) : null;
}

// Attaches whether each applicant already has an RT profile (matched by
// phone — the strong signal, same as educatorSearchService) and Joy's own
// review of that application (classification/call date/notes — separate
// from JobAdder's own status, see db/schema.sql's jobadder_application_
// reviews comment). One batched query each rather than N+1 per applicant.
async function enrichApplicants(applicants) {
  const db = getDb();
  const phoneByLast9 = new Map();
  for (const a of applicants) {
    const key = last9Digits(a.mobile);
    if (key) phoneByLast9.set(key, a);
  }
  const last9List = [...phoneByLast9.keys()];
  const rtByLast9 = new Map();
  if (last9List.length) {
    const res = await db.execute({
      sql: `SELECT user_id, first_name, last_name, contact_no, is_active, suburb,
                   RIGHT(regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g'), 9) AS last9
            FROM rt_candidates_cache
            WHERE RIGHT(regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g'), 9) = ANY(?)`,
      args: [last9List]
    });
    for (const row of res.rows) rtByLast9.set(row.last9, row);
  }

  const appIds = applicants.map(a => a.applicationId);
  const reviewById = new Map();
  if (appIds.length) {
    const res = await db.execute({
      sql: `SELECT * FROM jobadder_application_reviews WHERE application_id = ANY(?)`,
      args: [appIds]
    });
    for (const row of res.rows) reviewById.set(String(row.application_id), row);
  }

  return applicants.map(a => {
    const last9 = last9Digits(a.mobile);
    const rt = last9 ? rtByLast9.get(last9) : null;
    const review = reviewById.get(String(a.applicationId));
    return {
      ...a,
      rtProfile: rt ? { userId: rt.user_id, isActive: rt.is_active, suburb: rt.suburb } : null,
      classification: review?.classification || 'not_reviewed',
      callDate: review?.call_date || null,
      notes: review?.notes || null
    };
  });
}

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

// Lighter-weight than the full mapped shape in /ads/:adId/applications —
// dashboard only needs to count classifications, not render candidate
// details, so this skips the candidate/status/source fields entirely.
async function fetchApplicationIdsForAd(token, adId) {
  const ids = [];
  let offset = 0;
  const limit = 100;
  while (offset < 2000) {
    const res = await fetch(`${token.apiBaseUrl}/jobads/${adId}/applications?limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${token.accessToken}` }
    });
    if (!res.ok) break; // an ad that 404s/errors here just reports 0 applicants rather than failing the whole dashboard
    const data = await res.json();
    const page = data.items || [];
    for (const it of page) ids.push(it.applicationId);
    offset += limit;
    if (page.length < limit || offset >= (data.totalCount ?? 0)) break;
  }
  return ids;
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

// Dashboard (Joy, 2026-09-28: "how many applicants, how many reviewed, how
// many to move forward, % performance") — per open ad AND totals across
// all of them. Classification counts come from our own review table (see
// jobadder_application_reviews), joined against the real applicationIds
// JobAdder has right now for each ad — an application that's never been
// reviewed simply isn't in that table, which the LEFT JOIN-equivalent
// (Map lookup defaulting to 'not_reviewed' below) already handles.
router.get('/open-ads/dashboard', requireAdmin, async (req, res) => {
  try {
    const token = await jobAdderService.getValidAccessToken();
    if (!token) return res.status(400).json({ error: 'JobAdder is not connected.', notConnected: true });
    const all = await fetchAllJobAds(token);
    const openAds = all.filter(a => a.state === 'Current');
    const db = getDb();

    const perAd = [];
    const totals = { totalApplicants: 0, notReviewed: 0, moveForward: 0, notAFit: 0 };
    for (const ad of openAds) {
      const ids = await fetchApplicationIdsForAd(token, ad.adId);
      let classById = new Map();
      if (ids.length) {
        const r = await db.execute({
          sql: `SELECT application_id, classification FROM jobadder_application_reviews WHERE application_id = ANY(?)`,
          args: [ids]
        });
        classById = new Map(r.rows.map(row => [String(row.application_id), row.classification]));
      }
      let notReviewed = 0, moveForward = 0, notAFit = 0;
      for (const id of ids) {
        const c = classById.get(String(id)) || 'not_reviewed';
        if (c === 'move_forward') moveForward++;
        else if (c === 'not_a_fit') notAFit++;
        else notReviewed++;
      }
      const total = ids.length;
      const reviewed = moveForward + notAFit;
      perAd.push({
        adId: ad.adId, title: ad.title, reference: ad.reference,
        totalApplicants: total, notReviewed, moveForward, notAFit,
        reviewedPct: pct(reviewed, total),
        moveForwardPctOfTotal: pct(moveForward, total),
        moveForwardPctOfReviewed: pct(moveForward, reviewed)
      });
      totals.totalApplicants += total;
      totals.notReviewed += notReviewed;
      totals.moveForward += moveForward;
      totals.notAFit += notAFit;
    }
    const reviewedTotal = totals.moveForward + totals.notAFit;
    res.json({
      ads: perAd.sort((a, b) => b.totalApplicants - a.totalApplicants),
      totals: {
        ...totals,
        reviewedPct: pct(reviewedTotal, totals.totalApplicants),
        moveForwardPctOfTotal: pct(totals.moveForward, totals.totalApplicants),
        moveForwardPctOfReviewed: pct(totals.moveForward, reviewedTotal)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Applicants for one specific ad (Joy, 2026-09-28: click an open ad, see
// who applied). GET /jobads/{adId}/applications — real endpoint (the ad's
// own `links.applications` points here), needs read_jobapplication on top
// of read_jobad; confirmed live 2026-09-28 against a real ad (2 real
// applicants incl. candidate contact details, status/workflow stage,
// source e.g. "Seek", createdAt). Deliberately NOT fetching attachments
// here — the candidate's own attachments (incl. what they submitted for
// this application) are already shown by the existing candidate-detail
// modal via GET /candidates/:id/attachments, so clicking a name just opens
// that instead of duplicating attachment-serving logic.
router.get('/ads/:adId/applications', requireAdmin, async (req, res) => {
  try {
    const token = await jobAdderService.getValidAccessToken();
    if (!token) return res.status(400).json({ error: 'JobAdder is not connected.', notConnected: true });
    const items = [];
    let offset = 0;
    const limit = 100;
    while (offset < 2000) {
      const apiRes = await fetch(`${token.apiBaseUrl}/jobads/${encodeURIComponent(req.params.adId)}/applications?limit=${limit}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token.accessToken}` }
      });
      if (!apiRes.ok) {
        const body = await apiRes.text().catch(() => '');
        return res.status(apiRes.status === 404 ? 404 : 502).json({ error: body.slice(0, 300) || 'Failed to load applicants' });
      }
      const data = await apiRes.json();
      const page = data.items || [];
      items.push(...page);
      offset += limit;
      if (page.length < limit || offset >= (data.totalCount ?? 0)) break;
    }
    const mapped = items.map(a => ({
      applicationId: a.applicationId,
      candidateId: a.candidate?.candidateId ?? null,
      name: `${a.candidate?.firstName || ''} ${a.candidate?.lastName || ''}`.trim() || '(No name)',
      email: a.candidate?.email || null,
      mobile: a.candidate?.mobile || null,
      status: a.status?.name || null,
      stage: a.status?.workflow?.stage || null,
      source: a.source || null,
      appliedAt: a.createdAt || null
    })).sort((x, y) => new Date(y.appliedAt) - new Date(x.appliedAt));
    res.json({ totalCount: mapped.length, items: await enrichApplicants(mapped) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Joy's own review of one application — classification/call date/notes,
// separate from JobAdder's own status (see db/schema.sql's comment on
// jobadder_application_reviews). Upsert since the first save for an
// application is a genuine INSERT and every one after is an update to the
// same row.
router.put('/applications/:id/review', requireAdmin, async (req, res) => {
  const applicationId = Number(req.params.id);
  if (!Number.isInteger(applicationId)) return res.status(400).json({ error: 'Invalid application id.' });
  const { classification, callDate, notes } = req.body || {};
  if (classification !== undefined && !VALID_CLASSIFICATIONS.has(classification)) {
    return res.status(400).json({ error: `classification must be one of: ${[...VALID_CLASSIFICATIONS].join(', ')}` });
  }
  try {
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO jobadder_application_reviews (application_id, classification, call_date, notes, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, now())
            ON CONFLICT (application_id) DO UPDATE SET
              classification = excluded.classification, call_date = excluded.call_date,
              notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now()`,
      args: [applicationId, classification || 'not_reviewed', callDate || null, notes || null, req.user.email]
    });
    res.json({ success: true });
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
