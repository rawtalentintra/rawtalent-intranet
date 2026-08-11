const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const { normalizeStateToShort, buildMicropods } = require('../services/micropodService');

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

  const totalRes = await getDb().execute({
    sql: 'SELECT count(*)::int AS n FROM rt_candidates_cache WHERE is_active = true',
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
            AND raw->'addresses'->0->>'latitude' IS NOT NULL
            AND raw->'addresses'->0->>'longitude' IS NOT NULL`,
    args: []
  })).rows;

  const points = rows.map(r => ({
    userId: String(r.user_id),
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || `Candidate #${r.user_id}`,
    email: r.email || null,
    contactNo: r.contact_no || null,
    suburb: r.suburb || null,
    state: normalizeStateToShort(r.addr_state),
    lat: r.lat,
    lng: r.lng
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

async function getPodsForParams(req) {
  const state = normalizeStateToShort(req.query.state);
  if (!state) return { error: 'A valid state query param is required (e.g. VIC or SA)' };

  const gridKm = clamp(req.query.gridKm, 2, 10, 2);
  const minPodSize = clamp(req.query.minPodSize, 5, 100, 15);
  const cacheKey = `${state}:${gridKm}:${minPodSize}`;

  const cached = podsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return { state, gridKm, minPodSize, ...cached.result };

  const { points, totalActive, totalGeocoded } = await getCandidatePoints();
  const statePoints = points.filter(p => p.state === state);
  const { pods, unclusteredCount } = buildMicropods(statePoints, { gridKm, minPodSize });

  // Deterministic centroid-based id — stays stable across recomputation/
  // cache expiry so a stale client-side pod list can never point at the
  // wrong pod's candidates.
  const podsWithId = pods.map(pod => ({
    ...pod,
    id: `${state}-${Math.round(pod.centroid.lat * 1000)}-${Math.round(pod.centroid.lng * 1000)}`
  }));

  const result = { pods: podsWithId, unclusteredCount, totalActive, totalGeocoded, statePointCount: statePoints.length };
  podsCache.set(cacheKey, { result, expiresAt: Date.now() + PODS_CACHE_TTL_MS });
  return { state, gridKm, minPodSize, ...result };
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
    const candidates = points
      .filter(p => memberSet.has(p.userId))
      .map(({ userId, name, email, contactNo, suburb }) => ({ userId, name, email, contactNo, suburb }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ id: pod.id, name: pod.name, centroid: pod.centroid, candidateCount: pod.candidateCount, candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
