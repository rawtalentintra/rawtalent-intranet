// Classifies a lead as metro vs. regional, for the three cities RawTalent
// currently (or soon will) operate leads in — Melbourne (VIC), Adelaide
// (SA), Brisbane (QLD). Per Liam's 2026-08-24 directive: "for the leads,
// we want to remove the ones that are regional... bring up maps of
// Melbourne and Adelaide and Brisbane and see where the border is for
// like metropolitan... at some stage we might start going out to regional
// areas [so] let's archive those" (not delete).
//
// Deliberately a straight-line radius from each city's CBD, not an
// exhaustive suburb allow-list like melbourneTerritoryService.js's
// Liam/Justine split. That list answers a different question — *who*
// owns a Melbourne lead — and already includes genuinely far-flung outer
// suburbs (Warburton, Kinglake West, Healesville) that are themselves
// borderline-regional, so reusing it here would conflate two separate
// axes. A radius is a rougher approximation, but Liam's own framing
// ("bring up maps... see where the border is") reads as an approximate
// line to refine later, not one to get perfectly right on the first
// pass — and building an equivalent hand-enumerated suburb list for
// Adelaide/Brisbane from scratch, with no directive to work from the way
// Liam gave one for Melbourne, risks being wrong in ways that are harder
// to spot than a radius that's simply a bit too wide or narrow.
const mapboxService = require('./mapboxService');

const CBD = {
  VIC: { lat: -37.8136, lng: 144.9631 }, // Melbourne
  SA: { lat: -34.9285, lng: 138.6007 },  // Adelaide
  QLD: { lat: -27.4698, lng: 153.0251 }  // Brisbane
};

// Approximate Greater Capital City radius, km — tune these once real
// classifications get reviewed against actual lead addresses. Melbourne/
// Brisbane both sprawl further than Adelaide (e.g. Melbourne's Pakenham
// ~55km, Sunbury ~40km; Brisbane's Ipswich ~40km, Caboolture ~45km;
// Adelaide's Gawler ~40km already borderline, Victor Harbor ~80km is
// clearly regional).
const METRO_RADIUS_KM = { VIC: 60, SA: 40, QLD: 60 };

function normalizeState(raw) {
  const s = (raw || '').trim().toUpperCase();
  if (s === 'VICTORIA') return 'VIC';
  if (s === 'SOUTH AUSTRALIA') return 'SA';
  if (s === 'QUEENSLAND') return 'QLD';
  return s;
}

// null = "can't classify" (no coordinates, or a state with no defined
// metro rule — e.g. NSW/WA/TAS/NT/ACT, negligible lead volume today and
// never mentioned in Liam's directive) — callers should leave those
// leads alone, never treat null as "not regional".
function isRegional(state, lat, lng) {
  const st = normalizeState(state);
  const cbd = CBD[st];
  if (!cbd || lat == null || lng == null) return null;
  const distanceKm = mapboxService.haversineKm({ lat, lng }, cbd);
  return distanceKm > METRO_RADIUS_KM[st];
}

module.exports = { isRegional, normalizeState, CBD, METRO_RADIUS_KM };
