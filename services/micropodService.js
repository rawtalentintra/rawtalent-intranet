// Pure functions, no DB/HTTP — candidate state normalization + geographic
// density clustering ("Micropods") for the Workforce Partners section.

const CANONICAL_STATES = {
  VIC: 'victoria',
  NSW: 'new south wales',
  QLD: 'queensland',
  SA: 'south australia',
  WA: 'western australia',
  TAS: 'tasmania',
  NT: 'northern territory',
  ACT: 'australian capital territory'
};

// Tier-2 exact-match table. Trim/lowercase/punctuation-strip in tier 1
// already absorbs most casing/whitespace variants, so this mainly needs the
// short codes, full names, and the confirmed non-Latin variant.
const STATE_LOOKUP = {
  vic: 'VIC', victoria: 'VIC', '維多利亞省': 'VIC',
  nsw: 'NSW', 'new south wales': 'NSW',
  qld: 'QLD', queensland: 'QLD',
  sa: 'SA', 'south australia': 'SA',
  wa: 'WA', 'western australia': 'WA',
  tas: 'TAS', tasmania: 'TAS',
  nt: 'NT', 'northern territory': 'NT',
  act: 'ACT', 'australian capital territory': 'ACT'
};

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

// 3-tier resolution: clean → exact lookup → Levenshtein fallback (typos
// only, against full state names — abbreviations are excluded from the
// fallback to avoid false positives like SA vs WA at distance 1).
function normalizeStateToShort(rawState) {
  if (!rawState) return null;
  const cleaned = String(rawState)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (STATE_LOOKUP[cleaned]) return STATE_LOOKUP[cleaned];

  let best = null;
  let bestDist = Infinity;
  let secondBestDist = Infinity;
  for (const [code, fullName] of Object.entries(CANONICAL_STATES)) {
    const d = levenshtein(cleaned, fullName);
    if (d < bestDist) {
      secondBestDist = bestDist;
      bestDist = d;
      best = code;
    } else if (d < secondBestDist) {
      secondBestDist = d;
    }
  }
  if (best && bestDist <= 2 && bestDist < secondBestDist) return best;
  return null;
}

// Grid-bin points, then flood-fill merge 8-connected "core" cells — cells
// whose own point count clears `coreMinPerCell` — into pods, absorbing
// each core cluster's non-core neighbour cells as border members without
// letting them extend the frontier further. This is a cell-level take on
// DBSCAN's core/border distinction.
//
// A plain "merge any occupied adjacent cell" flood-fill (the first version
// of this function) was tried against real production data and rejected:
// Greater Melbourne's candidate pool is dense enough that nearly every 2km
// cell across the whole metro is occupied, so a naive flood-fill chains
// almost the entire city into one ~8,000-candidate "pod" — not an
// actionable local hub. Requiring a minimum density to seed a merge (and
// only merging through other dense cells, not just any occupied one) keeps
// distinct suburb-level hotspots separate, confirmed live: 27 sensible
// pods (Tarneit, Clyde North, Noble Park, Craigieburn, ...) instead of one
// blob, at gridKm=2/minPodSize=15/coreMinPerCell=20. A windowed (3x3 block
// sum) density check was also tried to soften grid-boundary artifacts, but
// it reintroduced the blob problem — neighbouring cells across a
// continuously dense metro are too correlated for windowing to keep them
// apart. Trade-off accepted: a real cluster that happens to split ~evenly
// across a single grid line right at `minPodSize` can be missed (each half
// under threshold on its own) — rare against real address data, which
// isn't adversarially aligned to the grid, and not worth the blob
// regression to fully close.
//
// km<->degree constants match services/mapboxService.js
// (distanceToSegmentKm) — duplicated locally rather than shared for two
// numeric literals.
// coreMinPerCell intentionally does NOT scale with minPodSize — they're
// different knobs. minPodSize is a pure post-filter on a merged pod's
// final total (raise it and you should just see fewer, bigger pods).
// coreMinPerCell controls what counts as a dense enough cell to seed a
// merge at all; tying it to minPodSize was tried and broke that
// expectation badly — raising minPodSize to 50 raised the seed bar high
// enough that a real, obviously-qualifying 390-candidate Adelaide pod
// stopped seeding entirely and vanished (confirmed live against
// production data). Fixed at the value validated against real VIC/SA
// data (see buildMicropods' header comment).
const DEFAULT_CORE_MIN_PER_CELL = 20;

function buildMicropods(points, { gridKm = 2, minPodSize = 15, coreMinPerCell = DEFAULT_CORE_MIN_PER_CELL } = {}) {
  if (!points.length) return { pods: [], unclusteredCount: 0 };
  const coreThreshold = coreMinPerCell;

  const refLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos((refLat * Math.PI) / 180);
  const cellLatDeg = gridKm / kmPerDegLat;
  const cellLngDeg = gridKm / kmPerDegLng;

  const cells = new Map();
  for (const p of points) {
    const cx = Math.floor(p.lat / cellLatDeg);
    const cy = Math.floor(p.lng / cellLngDeg);
    const key = cx + ':' + cy;
    if (!cells.has(key)) cells.set(key, { cx, cy, points: [] });
    cells.get(key).points.push(p);
  }

  const neighborsOf = (cell) => {
    const keys = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        keys.push((cell.cx + dx) + ':' + (cell.cy + dy));
      }
    }
    return keys;
  };

  const coreKeys = new Set([...cells.entries()].filter(([, c]) => c.points.length >= coreThreshold).map(([k]) => k));
  const visitedCore = new Set();
  const claimedBorder = new Set(); // prevents a border cell being absorbed into two components
  const pods = [];
  let pointsInPods = 0;
  const clusteredUserIds = new Set();

  for (const key of coreKeys) {
    if (visitedCore.has(key)) continue;
    const queue = [key];
    visitedCore.add(key);
    const componentCoreKeys = [key];

    while (queue.length) {
      const k = queue.shift();
      for (const nk of neighborsOf(cells.get(k))) {
        if (coreKeys.has(nk) && !visitedCore.has(nk)) {
          visitedCore.add(nk);
          queue.push(nk);
          componentCoreKeys.push(nk);
        }
      }
    }

    const memberKeys = new Set(componentCoreKeys);
    for (const ck of componentCoreKeys) {
      for (const nk of neighborsOf(cells.get(ck))) {
        if (cells.has(nk) && !coreKeys.has(nk) && !claimedBorder.has(nk)) {
          memberKeys.add(nk);
          claimedBorder.add(nk);
        }
      }
    }

    const componentPoints = [...memberKeys].flatMap((k) => cells.get(k).points);
    if (componentPoints.length >= minPodSize) {
      const lat = componentPoints.reduce((s, p) => s + p.lat, 0) / componentPoints.length;
      const lng = componentPoints.reduce((s, p) => s + p.lng, 0) / componentPoints.length;
      const suburbCounts = {};
      componentPoints.forEach((p) => {
        if (p.suburb) suburbCounts[p.suburb] = (suburbCounts[p.suburb] || 0) + 1;
      });
      const name = Object.entries(suburbCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || 'Unnamed area';
      pods.push({
        centroid: { lat, lng },
        name,
        candidateCount: componentPoints.length,
        memberIds: componentPoints.map((p) => p.userId)
      });
      pointsInPods += componentPoints.length;
      componentPoints.forEach((p) => clusteredUserIds.add(p.userId));
    }
  }

  pods.sort((a, b) => b.candidateCount - a.candidateCount);
  // Who's left over — too geographically spread out to seed a pod at this
  // density threshold (a real, expected outcome in a smaller/sparser
  // market like SA, not a bug; see routes/micropods.js's GET /unclustered
  // for how these are actually surfaced instead of just a bare count).
  const unclusteredMemberIds = points.filter((p) => !clusteredUserIds.has(p.userId)).map((p) => p.userId);
  return { pods, unclusteredCount: unclusteredMemberIds.length, unclusteredMemberIds };
}

module.exports = { normalizeStateToShort, buildMicropods };
