const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const { normalizeStateToShort, buildMicropods } = require('../services/micropodService');
const engagement = require('../services/educatorEngagementService');
const centreGeoService = require('../services/centreGeoService');
const { computeTerritoryStrategy } = require('../services/territoryStrategyService');
const { computeAdvertisingOpportunities, DEFAULT_RADIUS_KM, DEFAULT_MIN_EDUCATORS } = require('../services/advertisingOpportunityService');
const { getCentresAndBookings } = require('./centres');
const { LIAM, JUSTINE, partnerForSuburbState } = require('../services/melbourneTerritoryService');

// Candidate density clustering ("Micropods") for the Workforce Partners
// section — computed on read from rt_candidates_cache (nightly-synced), no
// dedicated table. qa_view excluded, matching routes/centres.js's
// precedent for Workforce-Partner-territory features.
router.use(requireAuth, requireRole('admin', 'super_admin', 'workforce_partner'));

const CANDIDATES_CACHE_TTL_MS = 10 * 60 * 1000; // underlying data only changes on the nightly RT sync
const PODS_CACHE_TTL_MS = 10 * 60 * 1000;

let candidatesCache = { points: null, totalActive: 0, totalGeocoded: 0, expiresAt: 0 };
const podsCache = new Map(); // `${state}:${gridKm}:${minPodSize}:${segment}` -> { result, expiresAt }

// Projects state/lat/lng/name/contact fields plus the facts Decision Area
// 1's educator segmentation needs (status/created_date/qualification/
// availability/compliance) via jsonb path expressions rather than pulling
// the full `raw` payload — no reason to move megabytes of JSON just to
// cluster ~13k points by coordinate and classify them.
async function getCandidatePoints() {
  if (candidatesCache.points && Date.now() < candidatesCache.expiresAt) return candidatesCache;

  // is_deleted = true alongside is_active = true is a rare RT data
  // inconsistency (confirmed live: 1 of 12,950 "active" rows) — excluded
  // explicitly so "active candidates only" can't have an edge case leak
  // through just because RT's own isActive/isDeleted flags disagree.
  //
  // status NOT IN (4, 8) excludes Do Not Use / Not Interested candidates —
  // the first place candidate.status gates Micropods supply at all (see
  // EXCLUDED_CANDIDATE_STATUSES in educatorEngagementService.js). Neither
  // represents real or prospective supply.
  const totalRes = await getDb().execute({
    sql: "SELECT count(*)::int AS n FROM rt_candidates_cache WHERE is_active = true AND is_deleted IS NOT TRUE AND status NOT IN (4, 8)",
    args: []
  });
  const totalActive = totalRes.rows[0]?.n || 0;

  // has_current_availability / fully_compliant computed as jsonb scalar
  // EXISTS checks (not full array extraction) so a malformed date/boolean
  // anywhere in 13k rows of nested jsonb can't abort the whole query —
  // deliberately using lexicographic ISO-string comparison (left(...,10)
  // >= 'YYYY-MM-DD'), not ::date/::timestamptz casts, for the same reason
  // (this table has documented dirty free-text elsewhere, e.g. the
  // addresses[].state field admin.html's candidateStates() normalizes).
  //
  // "Fully compliant" = no MANDATORY attachedRequirements entry that's
  // expired or unreviewed. This deliberately does NOT attempt to detect
  // wholesale-missing required document types — there's no canonical
  // "which docs are required for whom" list anywhere in this codebase,
  // that's a harder, separate problem this doesn't try to solve.
  //
  // isExpiry alone used to be treated as "expired" here — wrong, verified
  // against real production data (2026-08-30): it means "this requirement
  // TYPE tracks an expiry date at all", not a live expired flag (most
  // isExpiry=true rows have a perfectly normal future date). That bug
  // pushed a huge share of candidates into "onboarding_supply" who should
  // have landed in "available_engaged" — confirmed live: fixing this took
  // SA's Onboarding Supply count from 159 down to 80 and surfaced 78 real
  // Available & Engaged educators that had been invisible. Real
  // expiryDate vs. today, excluding RT's two sentinel dates
  // ('0001-01-01' unset, '9999-12-31' never-expires), is the only real
  // signal — same fix applied in services/rtCandidatesSyncService.js and
  // twice in admin.html, all four were the same copy-pasted mistake.
  const rows = (await getDb().execute({
    sql: `SELECT
            user_id, first_name, last_name, email, contact_no, suburb,
            status, created_date,
            raw->'addresses'->0->>'state' AS addr_state,
            (raw->'addresses'->0->>'latitude')::float8 AS lat,
            (raw->'addresses'->0->>'longitude')::float8 AS lng,
            raw->'qualifications'->0->>'qualificationName' AS qualification_name,
            EXISTS (
              SELECT 1 FROM jsonb_array_elements(coalesce(raw->'availableCandidateList','[]'::jsonb)) a
              WHERE left(a->>'date', 10) >= to_char(current_date, 'YYYY-MM-DD')
            ) AS has_current_availability,
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(coalesce(raw->'attachedRequirements','[]'::jsonb)) r
              WHERE (r->>'isMandatory')::boolean IS TRUE
                AND (
                     (r->>'isReviewed')::boolean IS NOT TRUE
                  OR (r->>'expiryDate' IS NOT NULL
                      AND left(r->>'expiryDate',10) NOT IN ('0001-01-01','9999-12-31')
                      AND left(r->>'expiryDate',10) < to_char(current_date,'YYYY-MM-DD'))
                )
            ) AS fully_compliant
          FROM rt_candidates_cache
          WHERE is_active = true
            AND is_deleted IS NOT TRUE
            AND status NOT IN (4, 8)
            AND raw->'addresses'->0->>'latitude' IS NOT NULL
            AND raw->'addresses'->0->>'longitude' IS NOT NULL`,
    args: []
  })).rows;

  // Segmentation (Decision Area 1, 2026-08-22): Currently Working / Newly
  // Activated / Available & Engaged / Warm Reactivation / Dormant or
  // Lapsed / Onboarding Supply — see classifyEducator() in
  // educatorEngagementService.js for the full definition and rationale.
  // bookingAggregates comes from the exact same 6-month RT bookings fetch
  // the original engagement split already used — no second RT call.
  const { bookingAggregates } = await engagement.getEngagedUserIds();

  const points = rows.map(r => {
    const agg = bookingAggregates.get(String(r.user_id));
    const facts = {
      status: r.status,
      fullyCompliant: r.fully_compliant,
      hasCurrentAvailability: r.has_current_availability,
      createdDate: r.created_date
    };
    return {
      userId: String(r.user_id),
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || `Candidate #${r.user_id}`,
      email: r.email || null,
      contactNo: r.contact_no || null,
      suburb: r.suburb || null,
      state: normalizeStateToShort(r.addr_state),
      lat: r.lat,
      lng: r.lng,
      segment: engagement.classifyEducator(facts, agg),
      fullyCompliant: r.fully_compliant,
      hasCurrentAvailability: r.has_current_availability,
      qualification: r.qualification_name || null,
      shifts28d: agg?.shiftsIn28Days || 0,
      daysSinceLastShift: agg?.lastWorkedDate
        ? Math.floor((Date.now() - new Date(agg.lastWorkedDate).getTime()) / 86400000)
        : null
    };
  }).filter(p =>
    // Exact (0,0) is RT's "never actually geocoded" sentinel ("null
    // island"), not a real address — confirmed against production data
    // (1,220 rows, all with otherwise-legit suburb/state text). Treated
    // as ungeocoded so it doesn't form a fake pod off the coast of Africa.
    Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0)
  );

  candidatesCache = { points, totalActive, totalGeocoded: points.length, expiresAt: Date.now() + CANDIDATES_CACHE_TTL_MS };
  return candidatesCache;
}

function clamp(n, min, max, fallback) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

// '' (all) or a comma-separated list of segment keys (checking multiple
// segments at once, e.g. "currently_working,warm_reactivation") — unknown
// keys are dropped rather than rejected, same permissive-default pattern
// as the state/gridKm/minPodSize parsing below. Returns an array; an empty
// array means "all segments", matching the empty-string sentinel used
// everywhere else in this file.
function parseSegmentFilter(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(s => s.trim()).filter(s => Object.prototype.hasOwnProperty.call(engagement.SEGMENTS, s));
}

// '', 'all' (case-insensitive), or missing all mean no state filter —
// every geocoded active candidate goes into clustering together. Grid
// cells are purely geographic, and VIC/SA are hundreds of km apart, so
// this produces the same pods as running each state separately and
// combining the lists — just in one pass. Anything else must resolve to
// a real state or it's a genuine bad request, unlike the empty/'all'
// case which is a deliberate, valid selection (matches "All States" on
// WFP Dashboard/My Centres/Leads — no state constraint at all, not
// narrowed to just VIC+SA).
function parseStateFilter(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') return { state: null, error: null };
  const normalized = normalizeStateToShort(trimmed);
  return normalized ? { state: normalized, error: null } : { state: null, error: `Unrecognised state "${trimmed}" — try VIC, SA, or leave blank for all states` };
}

// Sub-filter within VIC only — Liam's north/west territory vs Justine's
// east/south-east/bayside/Port Phillip split (services/melbourneTerritoryService.js,
// same suburb map the leads/centres auto-assign and the WFP Dashboard/My
// Centres/Leads state toggles already use). Ignored outside VIC — SA has
// no partner split, and 'all states' mixes VIC with SA/etc where a VIC-only
// partner label wouldn't make sense.
function parsePartnerFilter(raw) {
  const v = (raw || '').trim().toLowerCase();
  return v === 'liam' || v === 'justine' ? v : null;
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function emptySegmentCounts() {
  const counts = {};
  for (const key of Object.keys(engagement.SEGMENTS)) counts[key] = 0;
  return counts;
}

// Shared by the list view, Territory Strategy, and pod detail — one place
// that knows how to turn a pod's member points into the aggregate figures
// Decision Area 1 asked Micropods to show.
function computePodAggregates(memberPoints) {
  const segmentCounts = emptySegmentCounts();
  let availableNowCount = 0;
  let shifts28d = 0;
  const daysSinceValues = [];
  for (const p of memberPoints) {
    if (p.segment) segmentCounts[p.segment] = (segmentCounts[p.segment] || 0) + 1;
    if (p.hasCurrentAvailability) availableNowCount++;
    shifts28d += p.shifts28d || 0;
    if (p.daysSinceLastShift != null) daysSinceValues.push(p.daysSinceLastShift);
  }
  const activeSupplyCount = segmentCounts.currently_working + segmentCounts.newly_activated + segmentCounts.available_engaged;
  return { segmentCounts, activeSupplyCount, availableNowCount, shifts28d, medianDaysSinceLastShift: median(daysSinceValues) };
}

async function getPodsForParams(req) {
  const { state, error: stateError } = parseStateFilter(req.query.state);
  if (stateError) return { error: stateError };
  const partner = state === 'VIC' ? parsePartnerFilter(req.query.partner) : null;

  const gridKm = clamp(req.query.gridKm, 2, 10, 2);
  const minPodSize = clamp(req.query.minPodSize, 5, 100, 15);
  const segmentFilter = parseSegmentFilter(req.query.segment); // array; [] = all
  const cacheKey = `${state || 'ALL'}:${partner || ''}:${gridKm}:${minPodSize}:${[...segmentFilter].sort().join('|')}`;

  const cached = podsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return { state: state || '', partner: partner || '', gridKm, minPodSize, segments: segmentFilter, ...cached.result };

  const { points, totalActive, totalGeocoded } = await getCandidatePoints();
  let fullStatePoints = state ? points.filter(p => p.state === state) : points;
  // Liam's north/west VIC territory vs Justine's east/south-east/bayside/
  // Port Phillip split — same suburb map every other partner-aware VIC
  // filter in this app already uses (see melbourneTerritoryService.js's
  // header comment for why "outside the metro split falls back to
  // Justine" is the rule, not an error).
  if (partner) {
    const wanted = partner === 'liam' ? LIAM : JUSTINE;
    fullStatePoints = fullStatePoints.filter(p => partnerForSuburbState(p.suburb, 'VIC') === wanted);
  }
  let statePoints = fullStatePoints;
  // Filters the actual clustering input, not just a label applied
  // afterward — selecting segment(s) genuinely reclusters on just that
  // subset, so pod boundaries/counts reflect where THOSE candidates are,
  // not where the full active pool happens to be. Combines with state/
  // partner the same way state combines with gridKm/minPodSize: as an
  // independent AND. Checking multiple segments is a plain OR across them.
  if (segmentFilter.length) statePoints = statePoints.filter(p => segmentFilter.includes(p.segment));

  // buildMicropods' coreMinPerCell (how many people a 2km cell needs to
  // seed a pod) defaults to a fixed 20 — deliberately NOT tied to
  // minPodSize (see micropodService.js), but that constant was tuned
  // against the full ~9k-candidate VIC pool. Filtering to a segment (or a
  // partner territory) can shrink the pool far more than the old binary
  // engaged/not-engaged split ever did, and 20-per-cell never happens in a
  // pool that sparse — every Micropod call silently returned zero pods
  // regardless of minPodSize until this was caught live (see the original
  // engaged-only fix this comment is inherited from). Scaling the
  // threshold down by how much THIS filter thinned the state's pool keeps
  // the same "requires real local density" guard at whatever scale the
  // filtered pool actually is. Floor of 3 so it never drops low enough to
  // just merge every occupied cell again. Unfiltered calls (ratio 1) pass
  // undefined and fall through to buildMicropods' own default, so normal
  // behaviour is untouched.
  const coreMinPerCell = segmentFilter.length && fullStatePoints.length
    ? Math.max(3, Math.round(20 * (statePoints.length / fullStatePoints.length)))
    : undefined;
  const { pods, unclusteredCount } = buildMicropods(statePoints, { gridKm, minPodSize, ...(coreMinPerCell ? { coreMinPerCell } : {}) });

  // Deterministic centroid-based id — stays stable across recomputation/
  // cache expiry so a stale client-side pod list can never point at the
  // wrong pod's candidates. Rounded centroids can coincide across two
  // different segment filters for the same state, but a pod is always
  // looked up together with the same segment param that produced its
  // list, so that's never ambiguous in practice.
  const pointsByUserId = new Map(statePoints.map(p => [p.userId, p]));
  const podsWithId = pods.map(pod => {
    const memberPoints = pod.memberIds.map(id => pointsByUserId.get(id)).filter(Boolean);
    return { ...pod, id: `${state || 'ALL'}${partner ? '_' + partner.toUpperCase() : ''}-${Math.round(pod.centroid.lat * 1000)}-${Math.round(pod.centroid.lng * 1000)}`, ...computePodAggregates(memberPoints) };
  });

  const result = { pods: podsWithId, unclusteredCount, totalActive, totalGeocoded, statePointCount: statePoints.length };
  podsCache.set(cacheKey, { result, expiresAt: Date.now() + PODS_CACHE_TTL_MS });
  return { state: state || '', partner: partner || '', gridKm, minPodSize, segments: segmentFilter, ...result };
}

// Pod summaries only — no candidate arrays. This is the "no full list
// upfront" boundary the feature was explicitly asked for.
router.get('/', async (req, res) => {
  try {
    const result = await getPodsForParams(req);
    if (result.error) return res.status(400).json({ error: result.error });
    const { pods, unclusteredCount, totalActive, totalGeocoded } = result;
    res.json({
      pods: pods.map(({ id, name, centroid, candidateCount, segmentCounts, activeSupplyCount, availableNowCount, shifts28d, medianDaysSinceLastShift }) =>
        ({ id, name, centroid, candidateCount, segmentCounts, activeSupplyCount, availableNowCount, shifts28d, medianDaysSinceLastShift })),
      unclusteredCount,
      totalActive,
      totalGeocoded
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Territory Strategy — overlays demand (nearby RT centres' recent booking
// activity) onto Micropods' existing supply-side pods, answering the
// Workforce Partner Strategy Meeting doc's three framing questions in one
// view: where supply outstrips demand, where demand outstrips supply, and
// (via the recommendation text) what to do about it today. Registered as a
// literal path ahead of '/:podId' below — express matches routes in
// registration order, so this has to come first or '/:podId' would treat
// "territory-strategy" as a pod id and 404. Reuses routes/centres.js's own
// RT clients+bookings cache rather than re-fetching.
router.get('/territory-strategy', async (req, res) => {
  try {
    const result = await getPodsForParams(req);
    if (result.error) return res.status(400).json({ error: result.error });
    const radiusKm = clamp(req.query.radiusKm, 3, 50, 15);

    const { centres, bookings } = await getCentresAndBookings();
    const geocodes = await centreGeoService.getGeocodesForCentres(centres);
    const centresWithGeo = centres
      .filter(c => geocodes[c.centreKey])
      .map(c => ({ ...c, lat: geocodes[c.centreKey].lat, lng: geocodes[c.centreKey].lng }));

    const pods = computeTerritoryStrategy(result.pods, centresWithGeo, bookings, { radiusKm });

    res.json({
      pods: pods.map(({ id, name, centroid, candidateCount, activeSupplyCount, supply, nearbyCentreCount, demandBookings30d, quadrant, label, icon, action }) =>
        ({ id, name, centroid, candidateCount, activeSupplyCount, supply, nearbyCentreCount, demandBookings30d, quadrant, label, icon, action })),
      unclusteredCount: result.unclusteredCount,
      totalActive: result.totalActive,
      totalGeocoded: result.totalGeocoded,
      radiusKm,
      geocodedCentreCount: centresWithGeo.length,
      totalCentreCount: centres.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Advertising Opportunity Engine (Decision Area 2, 2026-08-22) — flags
// centres with fewer than DEFAULT_MIN_EDUCATORS educators who worked a
// shift in the last 28 days within DEFAULT_RADIUS_KM. Deliberately NOT
// pod-based (see services/advertisingOpportunityService.js's header for
// why) — a genuine per-centre, per-individual-educator-point radius
// check, bypassing Micropods' own clustering entirely. Radius/threshold
// are fixed constants, not query params, since the meeting locked those
// numbers explicitly rather than leaving them tunable like
// /territory-strategy's radiusKm. Registered as a literal path ahead of
// '/:podId' below, same reason as /territory-strategy above.
router.get('/advertising-opportunities', async (req, res) => {
  try {
    const { points } = await getCandidatePoints();
    const { centres, bookings } = await getCentresAndBookings();
    const geocodes = await centreGeoService.getGeocodesForCentres(centres);
    const centresWithGeo = centres
      .filter(c => geocodes[c.centreKey])
      .map(c => ({ ...c, lat: geocodes[c.centreKey].lat, lng: geocodes[c.centreKey].lng }));

    const opportunities = computeAdvertisingOpportunities(centresWithGeo, points, bookings);

    res.json({
      opportunities,
      radiusKm: DEFAULT_RADIUS_KM,
      minEducatorsThreshold: DEFAULT_MIN_EDUCATORS,
      totalActiveCentreCount: centres.length,
      geocodedCentreCount: centresWithGeo.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Street-level address lines aren't in getCandidatePoints() (deliberately
// lean — that query runs over all ~13k candidates for clustering, no
// reason to pull raw JSON for every one of them just for an address
// column). This runs only against one pod's members (tens to low
// thousands, never the full table), so pulling addressLine1/2 here is
// cheap.
async function getAddressLines(userIds) {
  if (!userIds.length) return {};
  const placeholders = userIds.map(() => '?').join(',');
  const rows = (await getDb().execute({
    sql: `SELECT user_id,
            raw->'addresses'->0->>'addressLine1' AS address_line1,
            raw->'addresses'->0->>'addressLine2' AS address_line2,
            raw->'addresses'->0->>'postCode' AS post_code
          FROM rt_candidates_cache
          WHERE user_id IN (${placeholders})`,
    args: userIds
  })).rows;
  const byUserId = {};
  for (const r of rows) {
    byUserId[String(r.user_id)] = [r.address_line1, r.address_line2].filter(Boolean).join(' ') || null;
    byUserId[String(r.user_id) + ':postCode'] = r.post_code || null;
  }
  return byUserId;
}

// One pod's actual candidates — only reachable once that specific pod has
// been selected (map bubble or list row), never fetched upfront.
router.get('/:podId', async (req, res) => {
  try {
    const result = await getPodsForParams(req);
    if (result.error) return res.status(400).json({ error: result.error });
    const pod = result.pods.find(p => p.id === req.params.podId);
    if (!pod) return res.status(404).json({ error: 'Pod not found for the given state/gridKm/minPodSize' });

    const { points } = await getCandidatePoints();
    const memberSet = new Set(pod.memberIds);
    const members = points.filter(p => memberSet.has(p.userId));
    const addressLines = await getAddressLines(members.map(p => p.userId));

    // lat/lng included here (not in the list-view pod summary) purely to
    // drive the per-pod heatmap once a pod is actually open — still never
    // exposed before that point.
    const candidates = members
      .map(({ userId, name, email, contactNo, suburb, lat, lng, segment, fullyCompliant, hasCurrentAvailability, qualification, shifts28d, daysSinceLastShift }) => ({
        userId, name, email, contactNo, suburb, lat, lng,
        segment, fullyCompliant, hasCurrentAvailability, qualification, shifts28d, daysSinceLastShift,
        address: [addressLines[userId], suburb, addressLines[userId + ':postCode']].filter(Boolean).join(', ') || null
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // "from RT's reporting API — known limitation": qualifications[] is
    // separately documented (RT API Data Reference, admin.html) as only
    // ever returning one entry per candidate, sometimes the wrong one —
    // this breakdown is directionally useful, not authoritative.
    const qualificationCounts = {};
    for (const c of candidates) {
      const key = c.qualification || 'Unknown';
      qualificationCounts[key] = (qualificationCounts[key] || 0) + 1;
    }

    res.json({
      id: pod.id, name: pod.name, centroid: pod.centroid, candidateCount: pod.candidateCount,
      ...computePodAggregates(members),
      qualificationCounts,
      candidates
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
