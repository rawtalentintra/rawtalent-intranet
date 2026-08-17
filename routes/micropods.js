const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const { normalizeStateToShort, buildMicropods } = require('../services/micropodService');
const engagement = require('../services/educatorEngagementService');

// Candidate density clustering ("Micropods") for the Workforce Partners
// section — computed on read from rt_candidates_cache (nightly-synced), no
// dedicated table. qa_view excluded, matching routes/centres.js's
// precedent for Workforce-Partner-territory features.
router.use(requireAuth, requireRole('admin', 'super_admin', 'workforce_partner'));

const CANDIDATES_CACHE_TTL_MS = 10 * 60 * 1000; // underlying data only changes on the nightly RT sync
const PODS_CACHE_TTL_MS = 10 * 60 * 1000;

let candidatesCache = { points: null, totalActive: 0, totalGeocoded: 0, expiresAt: 0 };
const podsCache = new Map(); // `${state}:${gridKm}:${minPodSize}` -> { result, expiresAt }

// Projects only state/lat/lng/name/contact fields via jsonb path
// expressions rather than pulling the full `raw` payload — no reason to
// move megabytes of JSON just to cluster ~13k points by coordinate.
async function getCandidatePoints() {
  if (candidatesCache.points && Date.now() < candidatesCache.expiresAt) return candidatesCache;

  // is_deleted = true alongside is_active = true is a rare RT data
  // inconsistency (confirmed live: 1 of 12,950 "active" rows) — excluded
  // explicitly so "active candidates only" can't have an edge case leak
  // through just because RT's own isActive/isDeleted flags disagree.
  const totalRes = await getDb().execute({
    sql: "SELECT count(*)::int AS n FROM rt_candidates_cache WHERE is_active = true AND is_deleted IS NOT TRUE",
    args: []
  });
  const totalActive = totalRes.rows[0]?.n || 0;

  const rows = (await getDb().execute({
    sql: `SELECT
            user_id, first_name, last_name, email, contact_no, suburb,
            raw->'addresses'->0->>'state' AS addr_state,
            (raw->'addresses'->0->>'latitude')::float8 AS lat,
            (raw->'addresses'->0->>'longitude')::float8 AS lng
          FROM rt_candidates_cache
          WHERE is_active = true
            AND is_deleted IS NOT TRUE
            AND raw->'addresses'->0->>'latitude' IS NOT NULL
            AND raw->'addresses'->0->>'longitude' IS NOT NULL`,
    args: []
  })).rows;

  // Actively Engaged vs Active — Not Engaged (see educatorEngagementService
  // — a real shift, Assigned/Completed, in the last 6 months). Every row
  // here is already active-only (see the WHERE above), so this is the same
  // classification the Candidates report shows, just attached per-point so
  // the engagement filter below can restrict clustering itself rather than
  // just labeling candidates after the fact.
  const { engagedUserIds } = await engagement.getEngagedUserIds();

  const points = rows.map(r => ({
    userId: String(r.user_id),
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || `Candidate #${r.user_id}`,
    email: r.email || null,
    contactNo: r.contact_no || null,
    suburb: r.suburb || null,
    state: normalizeStateToShort(r.addr_state),
    lat: r.lat,
    lng: r.lng,
    engaged: engagedUserIds.has(String(r.user_id))
  })).filter(p =>
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

// '' (all), 'engaged', or 'not_engaged' — anything else falls back to all,
// same permissive-default pattern as the state/gridKm/minPodSize parsing
// below rather than 400ing on a stray value.
function parseEngagementFilter(raw) {
  return raw === 'engaged' || raw === 'not_engaged' ? raw : '';
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

async function getPodsForParams(req) {
  const { state, error: stateError } = parseStateFilter(req.query.state);
  if (stateError) return { error: stateError };

  const gridKm = clamp(req.query.gridKm, 2, 10, 2);
  const minPodSize = clamp(req.query.minPodSize, 5, 100, 15);
  const engagementFilter = parseEngagementFilter(req.query.engagement);
  const cacheKey = `${state || 'ALL'}:${gridKm}:${minPodSize}:${engagementFilter}`;

  const cached = podsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return { state: state || '', gridKm, minPodSize, engagement: engagementFilter, ...cached.result };

  const { points, totalActive, totalGeocoded } = await getCandidatePoints();
  const fullStatePoints = state ? points.filter(p => p.state === state) : points;
  let statePoints = fullStatePoints;
  // Filters the actual clustering input, not just a label applied
  // afterward — "Actively Engaged" genuinely reclusters on just that
  // subset, so pod boundaries/counts reflect where THOSE candidates are,
  // not where the full active pool happens to be. Combines with state the
  // same way state combines with gridKm/minPodSize: as an independent AND.
  if (engagementFilter === 'engaged') statePoints = statePoints.filter(p => p.engaged);
  else if (engagementFilter === 'not_engaged') statePoints = statePoints.filter(p => !p.engaged);

  // buildMicropods' coreMinPerCell (how many people a 2km cell needs to
  // seed a pod) defaults to a fixed 20 — deliberately NOT tied to
  // minPodSize (see micropodService.js), but that constant was tuned
  // against the full ~9k-candidate VIC pool. Filtering to e.g. just
  // Actively Engaged candidates can shrink the pool 30x+ (VIC: ~9,200 ->
  // ~280), and 20-per-cell never happens in a pool that sparse — every
  // Micropod call silently returned zero pods regardless of minPodSize
  // until this was caught live. Scaling the threshold down by how much
  // THIS filter thinned the state's pool (not by minPodSize — that
  // coupling was already tried and rejected once) keeps the same
  // "requires real local density" guard at whatever scale the filtered
  // pool actually is. Floor of 3 so it never drops low enough to just
  // merge every occupied cell again. Unfiltered calls (ratio 1) pass
  // undefined and fall through to buildMicropods' own default, so normal
  // behaviour is untouched.
  const coreMinPerCell = engagementFilter && fullStatePoints.length
    ? Math.max(3, Math.round(20 * (statePoints.length / fullStatePoints.length)))
    : undefined;
  const { pods, unclusteredCount } = buildMicropods(statePoints, { gridKm, minPodSize, ...(coreMinPerCell ? { coreMinPerCell } : {}) });

  // Deterministic centroid-based id — stays stable across recomputation/
  // cache expiry so a stale client-side pod list can never point at the
  // wrong pod's candidates. Rounded centroids can coincide across two
  // different engagement filters for the same state, but a pod is always
  // looked up together with the same engagement param that produced its
  // list, so that's never ambiguous in practice.
  const podsWithId = pods.map(pod => ({
    ...pod,
    id: `${state || 'ALL'}-${Math.round(pod.centroid.lat * 1000)}-${Math.round(pod.centroid.lng * 1000)}`
  }));

  const result = { pods: podsWithId, unclusteredCount, totalActive, totalGeocoded, statePointCount: statePoints.length };
  podsCache.set(cacheKey, { result, expiresAt: Date.now() + PODS_CACHE_TTL_MS });
  return { state: state || '', gridKm, minPodSize, engagement: engagementFilter, ...result };
}

// Pod summaries only — no candidate arrays. This is the "no full list
// upfront" boundary the feature was explicitly asked for.
router.get('/', async (req, res) => {
  try {
    const result = await getPodsForParams(req);
    if (result.error) return res.status(400).json({ error: result.error });
    const { pods, unclusteredCount, totalActive, totalGeocoded } = result;
    res.json({
      pods: pods.map(({ id, name, centroid, candidateCount }) => ({ id, name, centroid, candidateCount })),
      unclusteredCount,
      totalActive,
      totalGeocoded
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
    // exposed before that point. `engaged` already comes from
    // getCandidatePoints() (see educatorEngagementService.js).
    const candidates = members
      .map(({ userId, name, email, contactNo, suburb, lat, lng, engaged }) => ({
        userId, name, email, contactNo, suburb, lat, lng, engaged,
        address: [addressLines[userId], suburb, addressLines[userId + ':postCode']].filter(Boolean).join(', ') || null
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const engagedCount = candidates.filter(c => c.engaged).length;

    res.json({
      id: pod.id, name: pod.name, centroid: pod.centroid, candidateCount: pod.candidateCount,
      engagedCount, notEngagedCount: candidates.length - engagedCount, candidates
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
