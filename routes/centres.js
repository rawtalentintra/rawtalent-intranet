const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireRole, requirePwaAccess } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const rtApi = require('../services/rtApiReportService');
const { flattenCentres, parseCentreKey } = require('../services/centreKeyService');
const { computeCentreHealth, bucketBookingsForCentre, lastMeaningfulBookingDate, MEANINGFUL_BOOKING_STATUSES } = require('../services/centreHealthService');
const { computeCentreNurture } = require('../services/centreNurtureService');
const { detectTimestampFromText } = require('../services/transcriptDateService');
const { extractPlainText } = require('../services/documentTextExtractor');
const { analyzeVisitFromTranscript } = require('../services/centreVisitAnalysisService');
const groqTranscription = require('../services/groqTranscriptionService');
const { BUCKETS, uploadBuffer, downloadAsBuffer, remove: removeFile, extForMimetype, ensureBucket, setFileResponseHeaders } = require('../services/storageService');
const { MELBOURNE_SUBURB_PARTNER, partnerForSuburbState } = require('../services/melbourneTerritoryService');
const { getGeocodesForCentres } = require('../services/centreGeoService');
const { shortState } = require('../services/centreMatchService');
const { computeSystemMilestones } = require('../services/centreMilestoneService');
const { CALL_ACTIVITY_TYPES, VISIT_ACTIVITY_TYPES, DECISIONS_REQUIRED } = require('../services/centreActivityTypeService');
const { createTask } = require('./tasks');

// Any format — a site-visit recording could be a phone-app voice memo, a
// Zoom/Teams export, a plain-text transcript, whatever the Workforce
// Partner actually captured, so no mimetype allowlist. Same 200MB cap as
// leadRecordingUpload (routes/leads.js) for the same reason (often audio/
// video, not a small document). Capped at 10 files per drop — plenty for
// "a recording plus its transcript", not meant for bulk archiving.
const centreRecordingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// RT resets assignedUserId to 0 (not null) on a cancelled booking that had
// someone assigned before it was pulled — verified against real data
// (statusId 6 "Cancelled" bookings with notes like "Last Min - Unwell").
// 0 isn't a real candidate id, so it has to be excluded explicitly
// wherever "was this booking actually filled by someone" matters —
// `!= null` alone lets it through.
function isRealAssignment(assignedUserId) {
  return assignedUserId != null && assignedUserId !== 0;
}

// Same inferred map admin.html's RT API Data Reference documents
// (BOOKING_STATUS_LABELS there) — duplicated here rather than shared
// since that copy lives in a big inline <script>, not a requirable
// module; both describe the same RT statusId values and should be kept
// in sync if either changes.
const BOOKING_STATUS_LABELS = { 1: 'Open', 2: 'Requested', 3: 'Assigned', 5: 'Completed', 6: 'Cancelled', 7: 'Unfilled' };
function bookingStatusLabel(statusId) {
  return BOOKING_STATUS_LABELS[statusId] || `Status ${statusId}`;
}

// Resolves a compact list of RT bookings (already filtered to a single
// centre + date range by the caller) into the shape the WFP app's Today/
// Upcoming booking lists need — status label + assigned educator name,
// soonest first. Named lookups are deduped across the whole list (a
// centre with several shifts filled by the same educator only costs one
// RT candidate call), matching topEducatorsForCentre's own "only resolve
// the handful actually present" approach just above it.
async function resolveBookingsForDisplay(bookings) {
  const ids = [...new Set(bookings.filter(b => isRealAssignment(b.assignedUserId)).map(b => b.assignedUserId))];
  const names = {};
  await Promise.all(ids.map(async id => {
    try {
      const candidate = await rtApi.fetchById('candidates', id);
      names[id] = [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || `Educator #${id}`;
    } catch {
      names[id] = `Educator #${id}`;
    }
  }));
  return bookings
    .slice()
    .sort((a, b) => new Date(a.bookingDate) - new Date(b.bookingDate))
    .map(b => ({
      bookingDate: b.bookingDate,
      startTime: b.startTime || null,
      endTime: b.endTime || null,
      statusId: b.statusId,
      statusLabel: bookingStatusLabel(b.statusId),
      filled: isRealAssignment(b.assignedUserId),
      assignedEducatorName: isRealAssignment(b.assignedUserId) ? (names[b.assignedUserId] || null) : null
    }));
}

// My Centres/Centre 360 — a Workforce Partner's real, live RT client book
// of business (~360 active centres today; RT has no per-partner
// assignment field, so this is unfiltered by partner for now — see the
// wfp_label column comment in db/schema.sql for the intended future hook).
// Narrower than routes/reports.js's requireAdmin (that route exposes the
// full Candidates/Timesheets surface, which workforce_partner shouldn't
// get). requirePwaAccess (not the plain role check this used to be) so
// this also covers a plain-role person granted can_use_wfp_pwa for the
// Workforce Partner PWA — that shell's own page-load gate (server.js)
// checks the exact same condition, so a person who can open the app can
// actually call its APIs too.
router.use(requireAuth, requirePwaAccess);

const BOOKING_WINDOW_DAYS = 100; // covers the 90-day health window with a few days' slack
const CACHE_TTL_MS = 5 * 60 * 1000;

// Bulk-fetching every RT client + 100 days of bookings costs one pair of
// API calls regardless of portfolio size (RT has no per-client booking
// filter — see rtApiReportService's parseFilters). At ~360 active centres
// this is cheap enough not to need a real sync table (contrast with
// rt_candidates_cache, justified by ~25k rows hit on every list load) — a
// short in-memory cache just avoids re-pulling on every page load within
// a few minutes of each other.
let cache = { centres: null, bookings: null, rawClients: null, expiresAt: 0 };

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
  // rawClients (pre-flatten, with each client's own locations[] intact) is
  // kept alongside the flattened `centres` shape — centreMatchService's
  // findMatches/findConfidentMatch (routes/leads.js's duplicate-check and
  // leadAutoSignService) need the nested locations[] shape, not one row
  // per location, so flattening it away here would lose what they need.
  cache = { centres, bookings, rawClients: clients, expiresAt: Date.now() + CACHE_TTL_MS };
  return cache;
}

// Dormancy (Decision Area 3, 2026-08-22: 12 months with no meaningful
// booking — see centreHealthService.js's DORMANCY_DAYS) needs a real last-
// booking date, which the 100-day window above can't answer — a centre
// with zero bookings in 100 days might have booked plenty 4-11 months ago,
// or not at all. This is a SEPARATE, wider (366-day) fetch and its own
// longer-lived cache, not a widened version of the shared 100-day one
// above — the same "different time window gets its own cache" convention
// services/educatorEngagementService.js already uses for its own 6-month
// bookings fetch, so Micropods/Territory Strategy/Smart Routing's much
// more frequently-hit 100-day fetch doesn't get slower for a signal only
// dormancy classification needs. 30-minute TTL (vs. the 5-minute one
// above) since a year-old booking history doesn't meaningfully change
// minute to minute the way "what's due today" does.
const DORMANCY_LOOKBACK_DAYS = 366;
const DORMANCY_CACHE_TTL_MS = 30 * 60 * 1000;
let dormancyCache = { lastBookingByCentreKey: null, expiresAt: 0 };

async function getLastBookingDates(centres) {
  if (dormancyCache.lastBookingByCentreKey && Date.now() < dormancyCache.expiresAt) return dormancyCache.lastBookingByCentreKey;
  const startDate = new Date(Date.now() - DORMANCY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const bookings = await rtApi.fetchAllPages('bookings', { startDate });
  const byKey = {};
  for (const c of centres) {
    byKey[c.centreKey] = lastMeaningfulBookingDate(bookings, { rtLocationId: c.rtLocationId, rtClientId: c.rtClientId });
  }
  dormancyCache = { lastBookingByCentreKey: byKey, expiresAt: Date.now() + DORMANCY_CACHE_TTL_MS };
  return byKey;
}

// Tiny table, queried fresh each time rather than cached alongside the RT
// centre/booking cache above — a "delete" should take effect immediately,
// not wait out a stale cache window.
async function getHiddenCentreKeys() {
  const rows = (await getDb().execute('SELECT centre_key FROM hidden_centres')).rows;
  return new Set(rows.map(r => r.centre_key));
}

// Same "tiny table, queried fresh each time" reasoning as getHiddenCentreKeys
// above — a manual reassignment should be reflected immediately, not wait
// out a cache window.
async function getCentrePartnerAssignments() {
  const rows = (await getDb().execute('SELECT centre_key, workforce_partner FROM centre_partner_assignments')).rows;
  const byKey = {};
  for (const row of rows) byKey[row.centre_key] = row.workforce_partner;
  return byKey;
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

function healthForCentre(centre, bookings, visits, lastBookingDate = null) {
  const now = new Date();
  const buckets = bucketBookingsForCentre(bookings, { rtLocationId: centre.rtLocationId, rtClientId: centre.rtClientId });
  const health = computeCentreHealth(centre, { visits, ...buckets, lastBookingDate }, now);
  const nurture = computeCentreNurture(centre, visits, health.category, now, { isStrategic: health.isStrategic, isEscalated: health.isEscalated });
  return {
    ...centre,
    health: health.category,
    healthReasons: health.reasons,
    isStrategic: health.isStrategic,
    isEscalated: health.isEscalated,
    nurture,
    bookings30dCount: buckets.bookings30d.length,
    bookingsPrev30dCount: buckets.bookingsPrev30d.length,
    bookings90dCount: buckets.bookings90d.length
  };
}

// Shared by the due-centres endpoint below and Smart Routing's /optimize
// centre lookup (routes/routePlanner.js) — computes health+nurture for a
// subset (or all) of the live centre list without a second RT fetch
// (getCentresAndBookings is already cached ~5min). `filterKeys`, when
// given, narrows to just those centreKeys before the (cheaper) visits
// lookup and health computation — no extra RT call either way.
async function centresWithNurture(filterKeys) {
  const { centres, bookings } = await getCentresAndBookings();
  const hidden = await getHiddenCentreKeys();
  let visible = hidden.size ? centres.filter(c => !hidden.has(c.centreKey)) : centres;
  if (filterKeys) {
    const keySet = new Set(filterKeys);
    visible = visible.filter(c => keySet.has(c.centreKey));
  }
  const visits = await visitsByCentreKey(visible.map(c => c.centreKey));
  const lastBookingByCentreKey = await getLastBookingDates(visible);
  return visible.map(c => healthForCentre(c, bookings, visits[c.centreKey] || [], lastBookingByCentreKey[c.centreKey] || null));
}

// Normalizes a healthForCentre(...) result into the exact "stop" field
// names Smart Routing's leads already use (id/centre_name/street_address/
// suburb/state/latitude/longitude) — see routes/routePlanner.js and
// public/admin.html's buildItinerary/drag-reorder/Google Maps export, all
// of which only read those fields regardless of what kind of stop it is.
// state is normalised to the short code (shortState) here, once, so
// nothing downstream (frontend state filter, formatLeadAddress) has to
// think about RT's full-name form again.
function toRouteStop(centreWithHealth, geocodes) {
  const coord = geocodes[centreWithHealth.centreKey];
  return {
    id: centreWithHealth.centreKey,
    type: 'centre',
    centre_name: centreWithHealth.name,
    street_address: centreWithHealth.streetAddress,
    suburb: centreWithHealth.suburb,
    state: shortState(centreWithHealth.state),
    latitude: coord ? coord.lat : null,
    longitude: coord ? coord.lng : null,
    rtClientId: centreWithHealth.rtClientId,
    rtLocationId: centreWithHealth.rtLocationId,
    nurture: centreWithHealth.nurture,
    health: centreWithHealth.health,
    // Decision Area 4's Route Modes/priority order/recommendation card all
    // need these — health/nurture alone weren't enough for Smart Routing
    // to distinguish e.g. a Strategic Declining centre from an ordinary
    // one, or to show a real reason/trend in the recommendation card.
    healthReasons: centreWithHealth.healthReasons,
    isStrategic: centreWithHealth.isStrategic,
    isEscalated: centreWithHealth.isEscalated,
    bookings30dCount: centreWithHealth.bookings30dCount,
    bookingsPrev30dCount: centreWithHealth.bookingsPrev30dCount
  };
}

// Every centre currently due for a call/visit (nurture.status !== 'on_track'),
// normalized to routing-stop shape and geocoded via the SAME cache
// Territory Strategy uses (centre_geocodes table) — never the leads
// geocode loop. Consumed directly by Smart Routing's /geofence (no HTTP
// round-trip — same in-process reuse pattern as getCentresAndBookings/
// visitsByCentreKey, already exported for micropods.js/leads.js) and via
// GET /due-for-routing below for the picker.
//
// Dormant centres are deliberately excluded here even though their status
// is never 'on_track' either (it's 'reactivation_candidate', see
// centreNurtureService.js) — Decision Area 3, Liam: "a blanket visit
// cadence for every dormant historical centre would consume time without
// necessarily creating value." They're still fully visible/selectable
// from My Centres' own health filter; this pool is just the automatic
// "due" suggestion, not the full centre list. An escalated dormant centre
// (status 'escalated' overrides 'reactivation_candidate') still comes
// through, since an active issue/allegation outranks even that exception.
async function getDueCentreStops() {
  const withHealth = await centresWithNurture();
  const due = withHealth.filter(c => c.nurture.status !== 'on_track' && c.nurture.status !== 'reactivation_candidate');
  const geocodes = await getGeocodesForCentres(due);
  return due.map(c => toRouteStop(c, geocodes));
}

// Resolves specific centres by key, WITHOUT re-filtering by due-status —
// once a Workforce Partner has picked a centre in Smart Routing, /optimize
// trusts that selection the same way it already trusts a selected lead's
// DB row (never re-validates the lead's pipeline status either).
async function getCentreStopsByKeys(centreKeys) {
  if (!centreKeys.length) return [];
  const withHealth = await centresWithNurture(centreKeys);
  const geocodes = await getGeocodesForCentres(withHealth);
  return withHealth.map(c => toRouteStop(c, geocodes));
}

// The full My Centres portfolio — matches the pattern of other full-
// dataset list endpoints in this app (Leads, Reports): compute everything
// once server-side, let the frontend filter/sort/search client-side
// rather than adding query-param plumbing for a ~360-row list.
// `?mine=true` (Workforce Partner PWA) — the only backend-enforced
// territory scoping this route has ever had; the existing state-filter
// buttons in My Centres are purely cosmetic client-side filters over the
// same unfiltered list every caller already receives (confirmed — see the
// PWA plan). Scopes to a real centre_partner_assignments row matching the
// caller's own wfp_label, falling back to the same suburb-default
// (partnerForSuburbState) the frontend already uses cosmetically for a
// centre with no explicit assignment. A caller with no wfp_label at all
// (Liam and every admin/super_admin today) has nothing to scope by, so
// `mine=true` is a no-op for them rather than returning an empty list.
router.get('/', async (req, res) => {
  try {
    const { centres, bookings } = await getCentresAndBookings();
    const hidden = await getHiddenCentreKeys();
    let visible = hidden.size ? centres.filter(c => !hidden.has(c.centreKey)) : centres;
    const visits = await visitsByCentreKey(visible.map(c => c.centreKey));
    const assignments = await getCentrePartnerAssignments();
    const lastBookingByCentreKey = await getLastBookingDates(visible);
    if (req.query.mine === 'true' && req.user.wfp_label) {
      visible = visible.filter(c => (assignments[c.centreKey] || partnerForSuburbState(c.suburb, c.state)) === req.user.wfp_label);
    }
    const withHealth = visible.map(c => ({
      ...healthForCentre(c, bookings, visits[c.centreKey] || [], lastBookingByCentreKey[c.centreKey] || null),
      assignedWorkforcePartner: assignments[c.centreKey] || null
    }));
    res.json(withHealth);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// The Melbourne suburb->partner map (Liam north/west vs Justine east/
// south-east/bayside, see melbourneTerritoryService) so the frontend's
// display-only defaultCentrePartner() fallback can do the same suburb
// lookup as the backend, for the rare centre with no real
// centre_partner_assignments row (e.g. a brand new RT client synced in
// after the one-time backfill). Registered ahead of GET /:centreKey for
// the same reason as /due-for-routing below.
router.get('/territory-map', (req, res) => {
  res.json(MELBOURNE_SUBURB_PARTNER);
});

// Smart Routing's due-centres pool — see routes/routePlanner.js and
// public/admin.html's Smart Routing section. Deliberately a separate
// endpoint from GET /, not a `?due=true` query param on it: that route's
// consumers (My Centres, WFP Dashboard) expect the flattened-centre shape
// (name/streetAddress/contactName/...); this one returns routing-stop
// shape (centre_name/street_address/...) so Smart Routing needs no
// translation layer of its own. Registered ahead of GET /:centreKey below
// — otherwise that route would swallow this literal path segment as an
// (invalid) centreKey.
router.get('/due-for-routing', async (req, res) => {
  try {
    res.json(await getDueCentreStops());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Decision Area 6's two activity-type taxonomies, straight from
// centreActivityTypeService.js — one call so the frontend never hardcodes
// a copy that could drift from the real list. Registered ahead of GET
// /:centreKey below for the same reason as due-for-routing above.
router.get('/activity-types', (req, res) => {
  res.json({
    callTypes: CALL_ACTIVITY_TYPES,
    visitTypes: VISIT_ACTIVITY_TYPES,
    decisionsRequired: DECISIONS_REQUIRED
  });
});

// Aggregate call/visit activity across ALL centres, for the WFP
// Dashboard's Team Activity section (Liam, 2026-09-02 — the KPI row was
// "just leads", he wants total activity for the day including centres
// visited, not just the new-business funnel). Same "fetch everything
// once, filter client-side" shape as GET / and /api/leads (state-filter
// buttons re-slice already-fetched data instantly rather than re-hitting
// the server), so no date range is applied here — the frontend buckets
// by today/this week itself. Registered ahead of GET /:centreKey below
// for the same reason as /activity-types above.
router.get('/activity-log', async (req, res) => {
  try {
    const { centres } = await getCentresAndBookings();
    const hidden = await getHiddenCentreKeys();
    const visible = hidden.size ? centres.filter(c => !hidden.has(c.centreKey)) : centres;
    const visits = await visitsByCentreKey(visible.map(c => c.centreKey));
    const rows = Object.entries(visits).flatMap(([centreKey, list]) =>
      list.filter(v => v.status === 'completed').map(v => ({
        centreKey,
        channel: v.channel || 'visit',
        visitDate: v.visit_date,
        createdAt: v.created_at,
        createdByEmail: v.created_by_email,
        createdByName: v.created_by_name
      }))
    );
    res.json(rows);
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
    const assignments = await getCentrePartnerAssignments();
    const lastBookingByCentreKey = await getLastBookingDates([centre]);
    res.json({
      ...healthForCentre(centre, bookings, visits, lastBookingByCentreKey[centre.centreKey] || null),
      assignedWorkforcePartner: assignments[centre.centreKey] || null
    });
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

// Manual per-centre Workforce Partner assignment — same admin/super_admin
// gate Leads' own "Change Workforce Partner" control already uses. Body
// `{ workforcePartner }` — omit/null to unassign back to "everyone sees
// it" (My Centres' default, unfiltered-by-partner view).
router.put('/:centreKey/assign-partner', requireRole('admin', 'super_admin'), async (req, res) => {
  const parsed = parseCentreKey(req.params.centreKey);
  if (!parsed) return res.status(400).json({ error: 'Invalid centre key' });
  try {
    const partner = req.body?.workforcePartner || null;
    if (partner) {
      await getDb().execute({
        sql: `INSERT INTO centre_partner_assignments (centre_key, workforce_partner, assigned_by_email, assigned_by_name)
              VALUES (?, ?, ?, ?)
              ON CONFLICT (centre_key) DO UPDATE SET workforce_partner = excluded.workforce_partner,
                assigned_by_email = excluded.assigned_by_email, assigned_by_name = excluded.assigned_by_name, assigned_at = now()`,
        args: [req.params.centreKey, partner, req.user.email, req.user.name || req.user.email]
      });
    } else {
      await getDb().execute({ sql: 'DELETE FROM centre_partner_assignments WHERE centre_key = ?', args: [req.params.centreKey] });
    }
    res.json({ success: true, assignedWorkforcePartner: partner });
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

// Shared by GET /:centreKey/educators below and the snapshot endpoint —
// "recent" educators, ranked by how often they've actually worked this
// centre, resolved to names via a live candidate lookup (mirrors the
// report dashboard's existing candidateName-by-id pattern). `limit` caps
// how many get their name resolved (the snapshot only wants a handful).
async function topEducatorsForCentre(parsed, bookings, limit = null) {
  const forCentre = bookings.filter(b =>
    (parsed.type === 'loc' ? b.locationId === parsed.id : b.clientId === parsed.id) &&
    isRealAssignment(b.assignedUserId) && MEANINGFUL_BOOKING_STATUSES.has(b.statusId)
  );
  const countByEducator = {};
  for (const b of forCentre) countByEducator[b.assignedUserId] = (countByEducator[b.assignedUserId] || 0) + 1;
  let educatorIds = Object.keys(countByEducator).sort((a, b) => countByEducator[b] - countByEducator[a]);
  if (limit) educatorIds = educatorIds.slice(0, limit);
  if (!educatorIds.length) return [];

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

  return educatorIds
    .map(id => ({ userId: Number(id), name: names[id], bookingCount: countByEducator[id] }))
    .sort((a, b) => b.bookingCount - a.bookingCount);
}

// Educator relationships tab — who's actually worked this centre, ranked
// by how often.
router.get('/:centreKey/educators', async (req, res) => {
  const parsed = parseCentreKey(req.params.centreKey);
  if (!parsed) return res.status(400).json({ error: 'Invalid centre key' });
  try {
    const { bookings } = await getCentresAndBookings();
    res.json(await topEducatorsForCentre(parsed, bookings));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// One-round-trip mobile "pre-meeting snapshot" (Workforce Partner PWA,
// Aug 26 meeting) — bundles what today takes 3 separate calls
// (GET /:centreKey, /:centreKey/bookings, /:centreKey/educators) into one,
// plus two fields that exist internally but were never returned as plain
// values before: a raw last-booking date, and today's/upcoming booking
// counts split out (rather than the caller counting the full booking
// list itself, wasteful on a slow mobile connection). "Live booking"
// (Liam's doc) is treated as "booking dated today" — RT has no concept of
// a currently-in-progress/checked-in shift to draw on instead; flag if
// something more real-time was actually meant.
router.get('/:centreKey/snapshot', async (req, res) => {
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
    const assignments = await getCentrePartnerAssignments();
    const lastBookingByCentreKey = await getLastBookingDates([centre]);
    const withHealth = healthForCentre(centre, bookings, visits, lastBookingByCentreKey[centre.centreKey] || null);

    const forCentre = bookings.filter(b => (parsed.type === 'loc' ? b.locationId === parsed.id : b.clientId === parsed.id));
    const filled = forCentre.filter(b => isRealAssignment(b.assignedUserId)).length;
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayRaw = forCentre.filter(b => b.bookingDate && b.bookingDate.slice(0, 10) === todayStr);
    // Capped rather than the full 100-day window's worth — this is a
    // phone-screen "what's coming up" list, not a report; 20 is generous
    // slack over what a single centre normally has booked ahead.
    const upcomingRaw = forCentre
      .filter(b => b.bookingDate && b.bookingDate.slice(0, 10) > todayStr)
      .sort((a, b) => new Date(a.bookingDate) - new Date(b.bookingDate))
      .slice(0, 20);
    const [todayBookings, upcomingBookings] = await Promise.all([
      resolveBookingsForDisplay(todayRaw),
      resolveBookingsForDisplay(upcomingRaw)
    ]);

    const educators = await topEducatorsForCentre(parsed, bookings, 5);
    const relationships = (await getDb().execute({
      sql: 'SELECT candidate_user_id, relationship_type, note FROM centre_educator_relationships WHERE centre_key = ?',
      args: [centre.centreKey]
    })).rows;
    const relByUserId = {};
    for (const r of relationships) (relByUserId[r.candidate_user_id] ||= []).push({ type: r.relationship_type, note: r.note });
    const educatorsWithTags = educators.map(e => ({ ...e, relationships: relByUserId[e.userId] || [] }));

    res.json({
      centreKey: centre.centreKey,
      name: centre.name,
      streetAddress: centre.streetAddress,
      suburb: centre.suburb,
      state: centre.state,
      contactName: centre.contactName,
      contactNo: centre.contactNo,
      email: centre.email,
      assignedWorkforcePartner: assignments[centre.centreKey] || null,
      health: withHealth.health,
      healthReasons: withHealth.healthReasons,
      nurture: withHealth.nurture,
      lastBookingDate: lastBookingByCentreKey[centre.centreKey] || null,
      fillRate: forCentre.length ? Math.round((filled / forCentre.length) * 100) : null,
      todayBookingsCount: todayRaw.length,
      upcomingBookingsCount: upcomingRaw.length,
      todayBookings,
      upcomingBookings,
      educators: educatorsWithTags
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Favourite / "known to centre" educator tagging — see
// centre_educator_relationships' schema comment for why the label must
// never read as "previously worked here through Raw Talent" (that's a
// distinct, unverified claim this doesn't make). Any signed-in user with
// PWA/centres access can add one; matches centre_visits' own ownership
// model (creator recorded, admin/super_admin can remove any).
router.get('/:centreKey/educator-relationships', async (req, res) => {
  try {
    const rows = (await getDb().execute({
      sql: 'SELECT * FROM centre_educator_relationships WHERE centre_key = ? ORDER BY created_at DESC',
      args: [req.params.centreKey]
    })).rows;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/:centreKey/educator-relationships', async (req, res) => {
  const { candidateUserId, relationshipType, note } = req.body;
  if (!candidateUserId) return res.status(400).json({ error: 'candidateUserId is required' });
  if (!['favourite', 'known_to_centre'].includes(relationshipType)) return res.status(400).json({ error: 'relationshipType must be favourite or known_to_centre' });
  try {
    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO centre_educator_relationships (id, centre_key, candidate_user_id, relationship_type, note, created_by, created_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, req.params.centreKey, String(candidateUserId), relationshipType, note || null, req.user.email, req.user.name || req.user.email]
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.delete('/:centreKey/educator-relationships/:id', async (req, res) => {
  try {
    const existing = await getDb().execute({ sql: 'SELECT created_by FROM centre_educator_relationships WHERE id = ? AND centre_key = ?', args: [req.params.id, req.params.centreKey] });
    const row = existing.rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.created_by.toLowerCase() !== req.user.email.toLowerCase() && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only the person who added this or an admin can remove it' });
    }
    await getDb().execute({ sql: 'DELETE FROM centre_educator_relationships WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Task-bridge for "request/rebook an educator" (Workforce Partner PWA) —
// RT has no booking-write API for this to call yet (confirmed — see the
// PWA plan), so this raises a real HeartBeat Task in the Bookings
// department instead of either faking a write RT can't accept or doing
// nothing. Retire this in favour of a real RT write once Raj/Yuvraj's API
// exists.
router.post('/:centreKey/request-booking', async (req, res) => {
  const { note, candidateUserId, candidateName } = req.body;
  const parsed = parseCentreKey(req.params.centreKey);
  if (!parsed) return res.status(400).json({ error: 'Invalid centre key' });
  try {
    const { centres } = await getCentresAndBookings();
    const centre = centres.find(c => c.centreKey === req.params.centreKey);
    if (!centre) return res.status(404).json({ error: 'Centre not found' });
    const title = candidateName ? `Book ${candidateName} at ${centre.name}` : `New booking request — ${centre.name}`;
    const description = [
      `Requested from the Workforce Partner app by ${req.user.name || req.user.email}.`,
      `Centre: ${centre.name}${centre.suburb ? ` (${centre.suburb})` : ''}`,
      note ? `Note: ${note}` : null
    ].filter(Boolean).join('\n');
    const id = await createTask({
      departmentId: 'bookings', title, description,
      linkedCandidates: candidateUserId ? [{ userId: candidateUserId, name: candidateName || null, phone: null }] : [],
      createdByEmail: req.user.email, createdByName: req.user.name
    });
    res.json({ success: true, taskId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// Attaches any recordings uploaded during this modal session (still
// visit_id = NULL at that point — see POST /:centreKey/recordings) to the
// visit that was just actually saved. Only fires once a person explicitly
// clicks Save, not the moment a file lands in the dropzone — matches
// "reachable by opening the specific visit they're attached to", never a
// standalone list.
async function linkRecordingsToVisit(centreKey, visitId, recordingIds) {
  if (!Array.isArray(recordingIds) || !recordingIds.length) return;
  const placeholders = recordingIds.map(() => '?').join(',');
  await getDb().execute({
    sql: `UPDATE centre_recordings SET visit_id = ? WHERE centre_key = ? AND id IN (${placeholders})`,
    args: [visitId, centreKey, ...recordingIds]
  });
}

// Mandatory fields, confirmed (Decision Area 6, 2026-08-24): visitDate +
// channel + activityType, plus outcome once the contact has actually
// happened (status 'completed') — a Planned/Rescheduled entry has no real
// outcome yet, so it isn't enforced there. Shared by POST/PUT below so the
// rule can't drift between create and edit.
function validateVisitFields({ visitDate, channel, activityType, outcome, status }) {
  if (!visitDate) return 'visitDate is required';
  if (!channel) return 'channel is required';
  if (!activityType) return 'activityType is required';
  if ((status || 'planned') === 'completed' && !outcome) return 'outcome is required once status is completed';
  return null;
}

router.post('/:centreKey/visits', async (req, res) => {
  const {
    visitDate, status, preVisitBrief, outcome, notes, nextStep, nextStepDueDate, recordingIds,
    channel, activityType, contactName, opportunityNotes, commitment, nextStepOwner, attendees, checklistCompleted
  } = req.body;
  const fieldError = validateVisitFields({ visitDate, channel, activityType, outcome, status });
  if (fieldError) return res.status(400).json({ error: fieldError });
  try {
    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO centre_visits (
              id, centre_key, visit_date, status, pre_visit_brief, outcome, notes,
              next_step, next_step_due_date, created_by_email, created_by_name,
              channel, activity_type, contact_name, opportunity_notes, commitment, next_step_owner, attendees, checklist_completed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, req.params.centreKey, visitDate, status || 'planned', preVisitBrief || null,
        outcome || null, notes || null, nextStep || null, nextStepDueDate || null,
        req.user.email, req.user.name || req.user.email,
        channel || 'visit', activityType || null, contactName || null, opportunityNotes || null,
        commitment || null, nextStepOwner || req.user.email, attendees || null,
        typeof checklistCompleted === 'boolean' ? checklistCompleted : null
      ]
    });
    await linkRecordingsToVisit(req.params.centreKey, id, recordingIds);
    const row = (await getDb().execute({ sql: 'SELECT * FROM centre_visits WHERE id = ?', args: [id] })).rows[0];
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:centreKey/visits/:visitId', async (req, res) => {
  const {
    visitDate, status, preVisitBrief, outcome, notes, nextStep, nextStepDueDate, recordingIds,
    channel, activityType, contactName, opportunityNotes, commitment, nextStepOwner, attendees, checklistCompleted
  } = req.body;
  const fieldError = validateVisitFields({ visitDate, channel, activityType, outcome, status });
  if (fieldError) return res.status(400).json({ error: fieldError });
  try {
    const result = await getDb().execute({
      sql: `UPDATE centre_visits SET
              visit_date = coalesce(?, visit_date), status = coalesce(?, status),
              pre_visit_brief = ?, outcome = ?, notes = ?, next_step = ?, next_step_due_date = ?,
              channel = coalesce(?, channel), activity_type = ?, contact_name = ?, opportunity_notes = ?,
              commitment = ?, next_step_owner = ?, attendees = ?, checklist_completed = ?,
              updated_at = now()
            WHERE id = ? AND centre_key = ?`,
      args: [
        visitDate || null, status || null, preVisitBrief || null, outcome || null,
        notes || null, nextStep || null, nextStepDueDate || null,
        channel || null, activityType || null, contactName || null, opportunityNotes || null,
        commitment || null, nextStepOwner || null, attendees || null,
        typeof checklistCompleted === 'boolean' ? checklistCompleted : null,
        req.params.visitId, req.params.centreKey
      ]
    });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Visit not found' });
    await linkRecordingsToVisit(req.params.centreKey, req.params.visitId, recordingIds);
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

// ── Recordings/transcripts ─────────────────────────────────────────
// Best-effort text extraction, used both to look for a real-world
// timestamp inside the file (transcriptDateService) and to feed
// analyzeVisitFromTranscript below — never blocks the upload itself if
// extraction fails, the format isn't text-based, or GROQ_API_KEY isn't
// configured (falls back to no detected date/summary either way).
// Real audio (a phone-recorded call/visit, or the "Start Recording
// Notes" mic capture in the Log a Call/Visit modal) goes through Groq
// Whisper first — same transcription service routes/leads.js's voice-
// note endpoint already uses — so it lands in the exact same
// text/analysis pipeline a .txt/.pdf transcript already gets, rather
// than needing a parallel one.
async function extractTextForDetection(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  try {
    if (ext === '.txt' || ext === '.vtt' || ext === '.srt') return file.buffer.toString('utf8');
    if (ext === '.pdf' || ext === '.docx') return await extractPlainText(file.buffer, file.originalname);
    if (file.mimetype && file.mimetype.startsWith('audio/') && groqTranscription.isConfigured()) {
      return await groqTranscription.transcribeAudio(file.buffer.toString('base64'), file.mimetype);
    }
  } catch { /* unreadable/corrupt file, or transcription failed — treat as no text available */ }
  return null;
}

router.get('/:centreKey/recordings', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: `SELECT id, filename, mimetype, filesize, detected_at, visit_id, uploaded_by_name, uploaded_by_email, created_at
            FROM centre_recordings WHERE centre_key = ? ORDER BY created_at DESC`,
      args: [req.params.centreKey]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stores the file(s) and returns what could be detected from them —
// timestamp, plus (new) an AI outcome/notes summary from whichever file
// yielded usable text — but does NOT create or touch any centre_visits row
// itself. Linking to a real visit only happens once the Log a Call/Visit
// modal is actually saved (see linkRecordingsToVisit above), so an upload
// is never silently attached to nothing the user reviewed.
router.post('/:centreKey/recordings', requireRole('admin', 'super_admin', 'workforce_partner'), centreRecordingUpload.array('files', 10), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files provided' });
  try {
    const db = getDb();
    const detections = await Promise.all(files.map(async file => {
      const text = await extractTextForDetection(file);
      return { file, text, detectedAt: detectTimestampFromText(text) };
    }));
    const detectedTimestamps = detections.map(d => d.detectedAt).filter(Boolean).sort();
    const detectedAt = detectedTimestamps[0] || null;

    // First file with usable text drives the AI summary — same "best
    // effort, never blocks the upload" posture as timestamp detection.
    const { centres } = await getCentresAndBookings();
    const centre = centres.find(c => c.centreKey === req.params.centreKey);
    const firstTextFile = detections.find(d => d.text && d.text.trim().length >= 20);
    const { outcome, notesSummary } = firstTextFile
      ? await analyzeVisitFromTranscript(firstTextFile.text, centre?.name)
      : { outcome: null, notesSummary: null };

    await ensureBucket(BUCKETS.centreRecordings);
    const saved = [];
    for (const { file, detectedAt: fileDetectedAt } of detections) {
      const result = await db.execute({
        sql: `INSERT INTO centre_recordings (centre_key, filename, mimetype, filesize, detected_at, uploaded_by_email, uploaded_by_name)
              VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [req.params.centreKey, file.originalname, file.mimetype, file.size, fileDetectedAt, req.user.email, req.user.name || req.user.email]
      });
      const recordingId = result.rows[0].id;
      const storagePath = `${req.params.centreKey}/${recordingId}.${extForMimetype(file.mimetype)}`;
      await uploadBuffer(BUCKETS.centreRecordings, storagePath, file.buffer, file.mimetype);
      await db.execute({ sql: 'UPDATE centre_recordings SET storage_path = ? WHERE id = ?', args: [storagePath, recordingId] });
      saved.push({ id: recordingId, filename: file.originalname, detectedAt: fileDetectedAt });
    }

    res.json({ recordings: saved, detectedAt, outcome, notesSummary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recordings/:recordingId/download', async (req, res) => {
  try {
    const file = (await getDb().execute({ sql: 'SELECT * FROM centre_recordings WHERE id = ?', args: [req.params.recordingId] })).rows[0];
    if (!file) return res.status(404).json({ error: 'Recording not found' });
    if (!file.storage_path) return res.status(404).json({ error: 'This recording has no stored content' });
    const buffer = await downloadAsBuffer(BUCKETS.centreRecordings, file.storage_path);
    setFileResponseHeaders(res, { mimetype: file.mimetype, filename: file.filename, wantInline: false });
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/recordings/:recordingId', requireRole('admin', 'super_admin', 'workforce_partner'), async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT storage_path FROM centre_recordings WHERE id = ?', args: [req.params.recordingId] });
    await db.execute({ sql: 'DELETE FROM centre_recordings WHERE id = ?', args: [req.params.recordingId] });
    if (existing.rows[0]?.storage_path) {
      try { await removeFile(BUCKETS.centreRecordings, existing.rows[0].storage_path); } catch { /* orphaned storage object, non-fatal */ }
    }
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
    const { centres, bookings } = await getCentresAndBookings();
    const centre = centres.find(c => c.centreKey === req.params.centreKey);
    const allForCentre = bookings.filter(b => (parsed.type === 'loc' ? b.locationId === parsed.id : b.clientId === parsed.id));
    const forCentre = allForCentre
      .sort((a, b) => new Date(b.bookingDate) - new Date(a.bookingDate))
      .slice(0, 10);

    const events = [
      ...visits.map(v => ({ type: 'visit', date: v.visit_date, data: v })),
      ...forCentre.map(b => ({ type: 'booking', date: b.bookingDate, data: b }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Decision Area 5's "full client timeline" — see
    // centreMilestoneService.js's header for why these are computed live
    // here rather than stored. allForCentre (not the sliced-to-10
    // `forCentre`) so "first/second booking" is genuinely the earliest
    // ones on record, not whatever happens to be in the 10 most recent.
    const milestones = computeSystemMilestones(centre, allForCentre);

    res.json({ events, milestones });
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
// Smart Routing (routes/routePlanner.js) needs the exact same due/not-due
// classification Centre 360 shows, never a second inconsistent definition.
module.exports.getDueCentreStops = getDueCentreStops;
module.exports.getCentreStopsByKeys = getCentreStopsByKeys;
