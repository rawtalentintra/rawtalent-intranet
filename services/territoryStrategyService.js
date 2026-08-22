// Territory Strategy — joins Micropods' existing supply-side clustering
// with demand computed from nearby RT centres' recent booking activity,
// answering the three questions the Workforce Partner Strategy Meeting doc
// opens with: where supply outstrips demand, where demand outstrips
// supply, and what a Workforce Partner should do about it today.
//
// Deliberately reuses whatever supply definition is already live — Active
// Supply (currently_working + newly_activated + available_engaged, see
// educatorEngagementService's classifyEducator / Decision Area 1) — rather
// than introducing a new one. The quadrant split itself is self-calibrating
// (median supply/demand across the pods in view) rather than a fixed
// threshold someone has to tune — the doc's proposed Grow/Recruit/Develop
// Business/Monitor framework depends on business-rule decisions (see
// Decision Area 2 of the review) that haven't been made yet, so this ships
// the structure now without pre-empting those calls with an arbitrary number.
const { haversineKm } = require('./mapboxService');
const { bucketBookingsForCentre } = require('./centreHealthService');

const DEFAULT_RADIUS_KM = 15;

const QUADRANTS = {
  grow: {
    label: 'Grow',
    icon: '🌱',
    action: 'Strong on both sides — keep growing together; look for adjacent expansion centres.'
  },
  recruit: {
    label: 'Recruit',
    icon: '🎯',
    action: 'Client demand here outpaces educator supply — prioritise recruiting/reactivating educators in this area.'
  },
  develop_business: {
    label: 'Develop Business',
    icon: '📈',
    action: 'Educator supply here outpaces current bookings — prioritise new centre acquisition/lead generation in this area.'
  },
  monitor: {
    label: 'Monitor',
    icon: '👀',
    action: 'Low activity on both sides relative to other areas — no urgent action, keep monitoring.'
  }
};

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function nearbyCentres(centroid, centresWithGeo, radiusKm) {
  return centresWithGeo.filter(c => haversineKm(centroid, { lat: c.lat, lng: c.lng }) <= radiusKm);
}

function demandForPod(pod, centresWithGeo, bookings, radiusKm) {
  const nearby = nearbyCentres(pod.centroid, centresWithGeo, radiusKm);
  let bookings30dCount = 0;
  for (const centre of nearby) {
    const { bookings30d } = bucketBookingsForCentre(bookings, { rtLocationId: centre.rtLocationId, rtClientId: centre.rtClientId });
    bookings30dCount += bookings30d.length;
  }
  return { nearbyCentreCount: nearby.length, demandBookings30d: bookings30dCount };
}

// Strictly-greater-than, not >=: real demand is zero-inflated (most pods
// have no nearby bookings at all within radiusKm), so the median itself is
// often 0 — with >=, every zero-demand pod would count as "high demand"
// too and the split would stop meaning anything. > keeps "high" meaning
// "genuinely above typical", including the median-is-zero case.
function classifyQuadrant(supply, demand, medianSupply, medianDemand) {
  const highSupply = supply > medianSupply;
  const highDemand = demand > medianDemand;
  if (highSupply && highDemand) return 'grow';
  if (!highSupply && highDemand) return 'recruit';
  if (highSupply && !highDemand) return 'develop_business';
  return 'monitor';
}

// centresWithGeo: centre rows (from centreKeyService.flattenCentres) each
// augmented with {lat, lng} (see centreGeoService.getGeocodesForCentres) —
// centres that couldn't be geocoded should already be filtered out by the
// caller so nearbyCentres never has to check for missing coordinates.
function computeTerritoryStrategy(pods, centresWithGeo, bookings, { radiusKm = DEFAULT_RADIUS_KM } = {}) {
  const enriched = pods.map(pod => {
    const supply = pod.activeSupplyCount ?? pod.candidateCount;
    const { nearbyCentreCount, demandBookings30d } = demandForPod(pod, centresWithGeo, bookings, radiusKm);
    return { ...pod, supply, nearbyCentreCount, demandBookings30d };
  });

  const medianSupply = median(enriched.map(p => p.supply));
  const medianDemand = median(enriched.map(p => p.demandBookings30d));

  return enriched.map(pod => {
    const quadrant = classifyQuadrant(pod.supply, pod.demandBookings30d, medianSupply, medianDemand);
    return { ...pod, quadrant, ...QUADRANTS[quadrant] };
  });
}

module.exports = { computeTerritoryStrategy, QUADRANTS, DEFAULT_RADIUS_KM };
