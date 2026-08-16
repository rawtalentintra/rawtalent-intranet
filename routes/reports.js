const express = require('express');
const router = express.Router();
const { requireAdmin, requireSuperAdmin } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const rtApi = require('../services/rtApiReportService');
const rtCandidatesSync = require('../services/rtCandidatesSyncService');
const engagement = require('../services/educatorEngagementService');

// Admin/super_admin only for now — access for other roles (e.g. Workforce
// Partners) can be revisited later once this is settled in, per how it
// was scoped when this was built.
router.use(requireAdmin);

const REPORT_TYPES = ['clients', 'candidates', 'bookings', 'timesheets'];

function parseFilters(req) {
  const { startDate, endDate, isActive } = req.query;
  return {
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    isActive: isActive === undefined || isActive === '' ? undefined : isActive === 'true'
  };
}

// Fast candidate name/email search backed by the local sync cache (see
// rtCandidatesSyncService.js) — RT's own API has no server-side search at
// all, so this is the only way to look someone up without pulling and
// filtering all ~25k candidates client-side. Deliberately lightweight
// (summary fields only, not the full nested record) since this only feeds
// a "find the candidate, then open them" picker — Document Checker fetches
// the FULL record live once a candidate is actually selected, same as the
// Candidate detail view, so a stale cache here never risks stale
// compliance data. Registered ahead of /candidates/:id — a distinct path
// segment, not a sub-path, so there's no route-matching ambiguity either way.
router.get('/candidates-search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  // A phone search only makes sense once there's a handful of digits typed
  // (a bare "1" or "20" would otherwise match almost every phone number in
  // the cache) — compared digits-only on both sides so "0421 413 425",
  // "+61421413425" and "421413425" all find the same candidate regardless
  // of how either side is formatted.
  const qDigits = q.replace(/\D/g, '');
  const conditions = [`(first_name || ' ' || last_name) ILIKE ?`, 'email ILIKE ?'];
  const args = [`%${q}%`, `%${q}%`];
  if (qDigits.length >= 4) {
    conditions.push(`regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g') ILIKE ?`);
    args.push(`%${qDigits}%`);
  }
  try {
    const result = await getDb().execute({
      sql: `SELECT user_id AS "userId", first_name AS "firstName", last_name AS "lastName", email, contact_no AS "contactNo", is_active AS "isActive"
            FROM rt_candidates_cache
            WHERE ${conditions.join(' OR ')}
            ORDER BY similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ?) DESC
            LIMIT 20`,
      args: [...args, q]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Which active candidates count as "Actively Engaged" (a real shift in the
// last 6 months) — see educatorEngagementService.js for the definition.
// Registered ahead of /candidates/:id below, same reason as
// /candidates-search and /candidates/sync-status: a literal path segment,
// not a param, so it must come first or Express would try to treat
// "engagement" as a candidate id.
router.get('/candidates/engagement', async (req, res) => {
  try {
    const { engagedUserIds, computedAt } = await engagement.getEngagedUserIds();
    res.json({ engagedUserIds: [...engagedUserIds], computedAt, lookbackMonths: engagement.LOOKBACK_MONTHS });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/candidates/sync-status', async (req, res) => {
  try {
    const state = await rtCandidatesSync.getSyncState();
    res.json({ ...state, isRunning: rtCandidatesSync.isSyncRunning(state) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual refresh — restricted to super_admin (a full sync hits RT for
// every one of ~25k candidates; the nightly schedule already covers
// routine freshness, so this is for "I need this right now," not routine
// use). Runs in the background and responds immediately — a real sync
// takes ~60s+, too long to hold an HTTP request open for; the frontend
// polls /candidates/sync-status instead.
router.post('/candidates/sync', requireSuperAdmin, async (req, res) => {
  try {
    const state = await rtCandidatesSync.getSyncState();
    if (rtCandidatesSync.isSyncRunning(state)) {
      return res.status(409).json({ error: 'A sync is already in progress.' });
    }
    rtCandidatesSync.syncAllCandidates(req.user.email).catch(err => console.error('Manual RT candidates sync error:', err.message));
    res.json({ started: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

REPORT_TYPES.forEach(type => {
  // Candidates' full list is served from the local cache instead of RT
  // live — see rt_candidates_cache in schema.sql for why (RT has no
  // "updated since" field, so a full nightly re-sync is the only way to
  // catch changes to existing candidates, not just new ones). Falls back
  // to a live fetch only if the cache is somehow still empty (e.g. between
  // deploy and the bootstrap sync finishing), so this route never just
  // returns nothing.
  if (type === 'candidates') {
    router.get('/candidates', async (req, res) => {
      try {
        const countRes = await getDb().execute('SELECT count(*) AS n FROM rt_candidates_cache');
        const filters = parseFilters(req);
        if (Number(countRes.rows[0].n) === 0) {
          const items = await rtApi.fetchAllPages('candidates', filters);
          return res.json(items);
        }
        // Mirrors the same startDate/endDate/isActive filters the live RT
        // fetch used to apply server-side, applied here against the cached
        // columns instead — the Dashboard tab's period/active selectors
        // still need to work the same way now that this reads from cache.
        const conditions = [];
        const args = [];
        if (filters.startDate) { conditions.push('created_date >= ?'); args.push(filters.startDate); }
        if (filters.endDate) { conditions.push('created_date < ?'); args.push(filters.endDate); }
        if (filters.isActive !== undefined) { conditions.push('is_active = ?'); args.push(filters.isActive); }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = await getDb().execute({
          sql: `SELECT raw FROM rt_candidates_cache ${where} ORDER BY created_date DESC NULLS LAST`,
          args
        });
        res.json(rows.rows.map(r => r.raw));
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
  } else {
    // Full dataset for the given filters — the dashboard computes all its
    // own KPIs/breakdowns client-side from this, same pattern as Leads/Sales.
    router.get(`/${type}`, async (req, res) => {
      try {
        const items = await rtApi.fetchAllPages(type, parseFilters(req));
        res.json(items);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
  }

  // Always a live fetch, every type including candidates — a specific
  // record (Candidate detail, Document Checker) must always reflect RT's
  // current state regardless of how stale the candidates list cache is.
  router.get(`/${type}/:id`, async (req, res) => {
    try {
      const item = await rtApi.fetchById(type, req.params.id);
      res.json(item);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
});

module.exports = router;
