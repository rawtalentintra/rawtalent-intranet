const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const rtApi = require('../services/rtApiReportService');
const { flattenCentres, parseCentreKey } = require('../services/centreKeyService');
const { computeCentreHealth, bucketBookingsForCentre, MEANINGFUL_BOOKING_STATUSES } = require('../services/centreHealthService');

// RT resets assignedUserId to 0 (not null) on a cancelled booking that had
// someone assigned before it was pulled — verified against real data
// (statusId 6 "Cancelled" bookings with notes like "Last Min - Unwell").
// 0 isn't a real candidate id, so it has to be excluded explicitly
// wherever "was this booking actually filled by someone" matters —
// `!= null` alone lets it through.
function isRealAssignment(assignedUserId) {
  return assignedUserId != null && assignedUserId !== 0;
}

// My Centres/Centre 360 — a Workforce Partner's real, live RT client book
// of business (~360 active centres today; RT has no per-partner
// assignment field, so this is unfiltered by partner for now — see the
// wfp_label column comment in db/schema.sql for the intended future hook).
// Narrower than routes/reports.js's requireAdmin (that route exposes the
// full Candidates/Timesheets surface, which workforce_partner shouldn't
// get) but open to workforce_partner for the centre-scoped data here.
router.use(requireAuth, requireRole('admin', 'super_admin', 'workforce_partner'));

const BOOKING_WINDOW_DAYS = 100; // covers the 90-day health window with a few days' slack
const CACHE_TTL_MS = 5 * 60 * 1000;

// Bulk-fetching every RT client + 100 days of bookings costs one pair of
// API calls regardless of portfolio size (RT has no per-client booking
// filter — see rtApiReportService's parseFilters). At ~360 active centres
// this is cheap enough not to need a real sync table (contrast with
// rt_candidates_cache, justified by ~25k rows hit on every list load) — a
// short in-memory cache just avoids re-pulling on every page load within
// a few minutes of each other.
let cache = { centres: null, bookings: null, expiresAt: 0 };

async function getCentresAndBookings() {
  if (cache.centres && Date.now() < cache.expiresAt) return cache;
  const startDate = new Date(Date.now() - BOOKING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [clients, bookings] = await Promise.all([
    rtApi.fetchAllPages('clients', {}),
    rtApi.fetchAllPages('bookings', { startDate })
  ]);
  // Deactivated/deleted/test client records (RT's own migration left ~925
  // of these, mostly locationless placeholder rows like "TEST Mabel" —
  // confirmed against real data) aren't centres a Workforce Partner
  // manages, so they're excluded before anything else sees this list.
  const centres = flattenCentres(clients).filter(c => c.isActive);
  cache = { centres, bookings, expiresAt: Date.now() + CACHE_TTL_MS };
  return cache;
}

// Tiny table, queried fresh each time rather than cached alongside the RT
// centre/booking cache above — a "delete" should take effect immediately,
// not wait out a stale cache window.
async function getHiddenCentreKeys() {
  const rows = (await getDb().execute('SELECT centre_key FROM hidden_centres')).rows;
  return new Set(rows.map(r => r.centre_key));
}

async function visitsByCentreKey(centreKeys) {
  if (!centreKeys.length) return {};
  const placeholders = centreKeys.map(() => '?').join(',');
  const rows = (await getDb().execute({
    sql: `SELECT * FROM centre_visits WHERE centre_key IN (${placeholders}) ORDER BY visit_date DESC`,
    args: centreKeys
  })).rows;
  const byKey = {};
  for (const row of rows) {
    (byKey[row.centre_key] ||= []).push(row);
  }
  return byKey;
}

function healthForCentre(centre, bookings, visits) {
  const buckets = bucketBookingsForCentre(bookings, { rtLocationId: centre.rtLocationId, rtClientId: centre.rtClientId });
  const health = computeCentreHealth(centre, { visits, ...buckets });
  return {
    ...centre,
    health: health.category,
    healthReasons: health.reasons,
    bookings30dCount: buckets.bookings30d.length,
    bookingsPrev30dCount: buckets.bookingsPrev30d.length,
    bookings90dCount: buckets.bookings90d.length
  };
}

// The full My Centres portfolio — matches the pattern of other full-
// dataset list endpoints in this app (Leads, Reports): compute everything
// once server-side, let the frontend filter/sort/search client-side
// rather than adding query-param plumbing for a ~360-row list.
router.get('/', async (req, res) => {
  try {
    const { centres, bookings } = await getCentresAndBookings();
    const hidden = await getHiddenCentreKeys();
    const visible = hidden.size ? centres.filter(c => !hidden.has(c.centreKey)) : centres;
    const visits = await visitsByCentreKey(visible.map(c => c.centreKey));
    const withHealth = visible.map(c => healthForCentre(c, bookings, visits[c.centreKey] || []));
    res.json(withHealth);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Centre 360 overview — re-fetches this one client live from RT so the
// name/contact/active status shown is always current even if the bulk
// list cache is a few minutes stale (same "list can lag, detail is
// live" principle as Candidates/Document Checker), but reuses the cached
// bulk bookings fetch for the trend computation since RT has no
// per-client booking filter to fetch just this one centre's bookings.
router.get('/:centreKey', async (req, res) => {
  const parsed = parseCentreKey(req.params.centreKey);
  if (!parsed) return res.status(400).json({ error: 'Invalid centre key' });
  try {
    if ((await getHiddenCentreKeys()).has(req.params.centreKey)) return res.status(404).json({ error: 'Centre not found' });
    const client = await rtApi.fetchById('clients', parsed.type === 'loc'
      ? (await findClientIdForLocation(parsed.id))
      : parsed.id
    );
    if (!client) return res.status(404).json({ error: 'Centre not found' });
    const [centre] = flattenCentres([client]).filter(c => c.centreKey === req.params.centreKey);
    if (!centre) return res.status(404).json({ error: 'Centre not found' });

    const { bookings } = await getCentresAndBookings();
    const visits = (await visitsByCentreKey([centre.centreKey]))[centre.centreKey] || [];
    res.json(healthForCentre(centre, bookings, visits));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// "Delete" a centre — really just excludes it from every My Centres/WFP
// Dashboard query from now on (see the hidden_centres comment in
// db/schema.sql for why this can't be a real delete: a centre is live RT
// data, not a row we own). admin/super_admin only, matching the visit-
// delete precedent below.
router.delete('/:centreKey', requireRole('admin', 'super_admin'), async (req, res) => {
  const parsed = parseCentreKey(req.params.centreKey);
  if (!parsed) return res.status(400).json({ error: 'Invalid centre key' });
  try {
    await getDb().execute({
      sql: `INSERT INTO hidden_centres (centre_key, reason, hidden_by_email, hidden_by_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (centre_key) DO NOTHING`,
      args: [req.params.centreKey, req.body?.reason || null, req.user.email, req.user.name || req.user.email]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A locationId alone doesn't say which client it belongs to — resolve it
// once from the cached centre list (rebuilt at most every 5 minutes) so
// Centre 360 can still do a live single-client re-fetch by clientId.
async function findClientIdForLocation(rtLocationId) {
  const { centres } = await getCentresAndBookings();
  const match = centres.find(c => c.rtLocationId === rtLocationId);
  return match ? match.rtClientId : null;
}

// Booking performance tab — this centre's own bookings within `range`,
// most recent first, plus a simple fill-rate figure.
router.get('/:centreKey/bookings', async (req, res) => {
  const parsed = parseCentreKey(req.params.centreKey);
  if (!parsed) return res.status(400).json({ error: 'Invalid centre key' });
  try {
    const { bookings } = await getCentresAndBookings();
    const forCentre = bookings.filter(b =>
      parsed.type === 'loc' ? b.locationId === parsed.id : b.clientId === parsed.id
    );
    const filled = forCentre.filter(b => isRealAssignment(b.assignedUserId)).length;
    res.json({
      bookings: forCentre.sort((a, b) => new Date(b.bookingDate) - new Date(a.bookingDate)),
      fillRate: forCentre.length ? Math.round((filled / forCentre.length) * 100) : null
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Educator relationships tab — who's actually worked this centre, ranked
// by how often, resolved to names via a live candidate lookup (mirrors
// the report dashboard's existing candidateName-by-id pattern).
router.get('/:centreKey/educators', async (req, res) => {
  const parsed = parseCentreKey(req.params.centreKey);
  if (!parsed) return res.status(400).json({ error: 'Invalid centre key' });
  try {
    const { bookings } = await getCentresAndBookings();
    const forCentre = bookings.filter(b =>
      (parsed.type === 'loc' ? b.locationId === parsed.id : b.clientId === parsed.id) &&
      isRealAssignment(b.assignedUserId) && MEANINGFUL_BOOKING_STATUSES.has(b.statusId)
    );
    const countByEducator = {};
    for (const b of forCentre) countByEducator[b.assignedUserId] = (countByEducator[b.assignedUserId] || 0) + 1;
    const educatorIds = Object.keys(countByEducator);
    if (!educatorIds.length) return res.json([]);

    // Only worth resolving names for the educators who actually appear
    // here (a handful per centre), not every candidate in RT.
    const names = {};
    await Promise.all(educatorIds.map(async id => {
      try {
        const candidate = await rtApi.fetchById('candidates', id);
        names[id] = [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || `Educator #${id}`;
      } catch {
        names[id] = `Educator #${id}`;
      }
    }));

    const result = educatorIds
      .map(id => ({ userId: Number(id), name: names[id], bookingCount: countByEducator[id] }))
      .sort((a, b) => b.bookingCount - a.bookingCount);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Visits ──────────────────────────────────────────────────────────
router.get('/:centreKey/visits', async (req, res) => {
  try {
    const rows = (await getDb().execute({
      sql: 'SELECT * FROM centre_visits WHERE centre_key = ? ORDER BY visit_date DESC',
      args: [req.params.centreKey]
    })).rows;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:centreKey/visits', async (req, res) => {
  const { visitDate, status, purpose, preVisitBrief, outcome, notes, nextStep, nextStepDueDate } = req.body;
  if (!visitDate) return res.status(400).json({ error: 'visitDate is required' });
  try {
    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO centre_visits (
              id, centre_key, visit_date, status, purpose, pre_visit_brief, outcome, notes,
              next_step, next_step_due_date, created_by_email, created_by_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, req.params.centreKey, visitDate, status || 'planned', purpose || null, preVisitBrief || null,
        outcome || null, notes || null, nextStep || null, nextStepDueDate || null,
        req.user.email, req.user.name || req.user.email
      ]
    });
    const row = (await getDb().execute({ sql: 'SELECT * FROM centre_visits WHERE id = ?', args: [id] })).rows[0];
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:centreKey/visits/:visitId', async (req, res) => {
  const { visitDate, status, purpose, preVisitBrief, outcome, notes, nextStep, nextStepDueDate } = req.body;
  try {
    const result = await getDb().execute({
      sql: `UPDATE centre_visits SET
              visit_date = coalesce(?, visit_date), status = coalesce(?, status), purpose = ?,
              pre_visit_brief = ?, outcome = ?, notes = ?, next_step = ?, next_step_due_date = ?,
              updated_at = now()
            WHERE id = ? AND centre_key = ?`,
      args: [
        visitDate || null, status || null, purpose || null, preVisitBrief || null, outcome || null,
        notes || null, nextStep || null, nextStepDueDate || null, req.params.visitId, req.params.centreKey
      ]
    });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Visit not found' });
    const row = (await getDb().execute({ sql: 'SELECT * FROM centre_visits WHERE id = ?', args: [req.params.visitId] })).rows[0];
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:centreKey/visits/:visitId', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM centre_visits WHERE id = ?', args: [req.params.visitId] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Relationship history — visits merged with recent bookings into one
// chronological feed. No lead_notes here: this app's 0 leads have ever
// reached signed_status='signed' in production, so there's no real
// leads-history to merge in yet (see centreMatchService.js — built and
// ready for once a centre does originate from a closed lead).
router.get('/:centreKey/activity', async (req, res) => {
  const parsed = parseCentreKey(req.params.centreKey);
  if (!parsed) return res.status(400).json({ error: 'Invalid centre key' });
  try {
    const visits = (await getDb().execute({
      sql: 'SELECT * FROM centre_visits WHERE centre_key = ? ORDER BY visit_date DESC',
      args: [req.params.centreKey]
    })).rows;
    const { bookings } = await getCentresAndBookings();
    const forCentre = bookings
      .filter(b => (parsed.type === 'loc' ? b.locationId === parsed.id : b.clientId === parsed.id))
      .sort((a, b) => new Date(b.bookingDate) - new Date(a.bookingDate))
      .slice(0, 10);

    const events = [
      ...visits.map(v => ({ type: 'visit', date: v.visit_date, data: v })),
      ...forCentre.map(b => ({ type: 'booking', date: b.bookingDate, data: b }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(events);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
// Attached rather than re-fetched: Territory Strategy (routes/micropods.js)
// needs the same live RT clients+bookings pull this file already caches —
// exporting the function lets it share the one in-memory cache instead of
// doubling the RT API calls on every load.
module.exports.getCentresAndBookings = getCentresAndBookings;
// Client Retention (routes/leads.js) needs the same centre_visits lookup
// this file already has — exported rather than duplicated.
module.exports.visitsByCentreKey = visitsByCentreKey;
