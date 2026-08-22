// Advertising Opportunity Engine (Decision Area 2, 2026-08-22) — flags
// centres with a genuine local supply gap: fewer than a fixed number of
// educators who've actually worked recently within a fixed radius. Numbers
// (5km / 10 educators) were locked live in the meeting, not left tunable
// like Territory Strategy's radius — see the header comment there for why
// that one stayed self-calibrating and this one didn't.
//
// Deliberately NOT pod-based — Micropods' own "nearest supply" (Priority
// Today's badge, admin.html's nearestSupplyContext) picks whichever WHOLE
// POD's centroid is nearest and reports that pod's aggregate count, which
// is the wrong granularity for a per-centre check like this one. This
// filters individual geocoded educator points directly against each
// centre's own coordinates.
const { haversineKm } = require('./mapboxService');
const { bucketBookingsForCentre } = require('./centreHealthService');

const DEFAULT_RADIUS_KM = 5;
const DEFAULT_MIN_EDUCATORS = 10;

// centresWithGeo: centre rows augmented with {lat, lng} — caller filters
// out ungeocoded centres first, same convention as
// territoryStrategyService.js's centresWithGeo.
// candidatePoints: getCandidatePoints().points shape from
// routes/micropods.js — already carries shifts28d, the exact "worked a
// shift in the last 28 days" ("currently working") test the meeting
// agreed on, so no new definition is introduced here.
// bookings: from routes/centres.js's getCentresAndBookings().
//
// Returns only FLAGGED centres (a flagged-list feature, not a
// health-scored list of everything like Territory Strategy), sorted by
// nearbyWorkingEducatorCount ascending (worst gap first), demandBookings30d
// descending as a tiebreaker.
function computeAdvertisingOpportunities(centresWithGeo, candidatePoints, bookings, { radiusKm = DEFAULT_RADIUS_KM, minEducators = DEFAULT_MIN_EDUCATORS } = {}) {
  const opportunities = [];
  for (const centre of centresWithGeo) {
    const nearbyWorkingEducatorCount = candidatePoints.filter(p =>
      p.shifts28d >= 1 && haversineKm(centre, { lat: p.lat, lng: p.lng }) <= radiusKm
    ).length;
    // Strict "<", not "<=" — the meeting's own wording was "fewer than 10",
    // a literal headcount floor, not a zero-inflated/relative split like
    // Territory Strategy's median comparison.
    if (nearbyWorkingEducatorCount >= minEducators) continue;
    const { bookings30d } = bucketBookingsForCentre(bookings, { rtLocationId: centre.rtLocationId, rtClientId: centre.rtClientId });
    opportunities.push({
      centreKey: centre.centreKey,
      name: centre.name,
      suburb: centre.suburb,
      state: centre.state,
      nearbyWorkingEducatorCount,
      demandBookings30d: bookings30d.length,
      action: `Fewer than ${minEducators} educators currently working within ${radiusKm}km — prioritise recruitment/reactivation advertising for this centre.`
    });
  }
  opportunities.sort((a, b) => a.nearbyWorkingEducatorCount - b.nearbyWorkingEducatorCount || b.demandBookings30d - a.demandBookings30d);
  return opportunities;
}

module.exports = { computeAdvertisingOpportunities, DEFAULT_RADIUS_KM, DEFAULT_MIN_EDUCATORS };
