// Geocodes RT centre addresses for Territory Strategy's demand-vs-supply
// matching (and Smart Routing's map). RT DOES pre-geocode most locations
// (ClientLocationResponse.latitude/longitude — confirmed against live
// data 2026-09-01, same as rt_candidates_cache's addresses already used
// via routes/micropods.js) and centreKeyService.flattenCentres() now
// carries that through, so this prefers RT's own coordinate outright —
// it's a real, centre-specific value RT already resolved, not a second
// independent guess from re-parsing the address text. Mapbox (geocode
// once, cache permanently in centre_geocodes — a street address
// essentially never moves) is only a fallback for the rare
// location RT hasn't geocoded on its side.
//
// This matters beyond just saving a Mapbox call: re-geocoding via a
// constructed "street, suburb state, Australia" string can mismatch on an
// ambiguous/abbreviated address and silently place a centre's pin
// somewhere else in Melbourne — reported 2026-09-01 as a Frankston centre
// plotting near South Melbourne on the Smart Routing map. Preferring RT's
// value also self-heals any such bad entry already sitting in
// centre_geocodes from before this, since it's simply never consulted for
// a centre RT can geocode itself.
const { getDb } = require('../db/database');
const mapboxService = require('./mapboxService');

// Bounded so a cold cache (e.g. first Territory Strategy load after a new
// centre appears) doesn't serialize hundreds of sequential Mapbox calls
// behind one request — 20 concurrent keeps a ~360-centre cold run to a
// handful of seconds without hammering the API.
const GEOCODE_CONCURRENCY = 20;

async function getCachedGeocodes(centreKeys) {
  if (!centreKeys.length) return {};
  const placeholders = centreKeys.map(() => '?').join(',');
  const rows = (await getDb().execute({
    sql: `SELECT centre_key, lat, lng FROM centre_geocodes WHERE centre_key IN (${placeholders})`,
    args: centreKeys
  })).rows;
  const byKey = {};
  for (const r of rows) byKey[r.centre_key] = { lat: r.lat, lng: r.lng };
  return byKey;
}

async function saveGeocode(centreKey, coord) {
  await getDb().execute({
    sql: `INSERT INTO centre_geocodes (centre_key, lat, lng, geocoded_at) VALUES (?, ?, ?, now())
          ON CONFLICT (centre_key) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, geocoded_at = now()`,
    args: [centreKey, coord.lat, coord.lng]
  });
}

// RT's own coordinate wins outright wherever it has one, else whatever's
// already sitting in the centre_geocodes cache — never touches Mapbox.
// Split out of getGeocodesForCentres so a plain list load (GET /, the
// /wfp mobile app's "nearby centres" — 2026-09-03) can get coordinates
// for whatever's already resolved without ever triggering a live geocode
// call for the rest, unlike the routing endpoints below which need every
// selected centre placed and are fine paying for that.
async function getCachedGeocodesOnly(centres) {
  const byKey = {};
  const needsCacheLookup = [];
  for (const c of centres) {
    if (Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) byKey[c.centreKey] = { lat: c.latitude, lng: c.longitude };
    else needsCacheLookup.push(c.centreKey);
  }
  if (needsCacheLookup.length) Object.assign(byKey, await getCachedGeocodes(needsCacheLookup));
  return byKey;
}

// Returns { [centreKey]: {lat, lng} } for every centre it could place —
// centres with no usable address, or whose address Mapbox can't resolve,
// are simply absent from the result rather than failing the whole call.
async function getGeocodesForCentres(centres) {
  const byKey = await getCachedGeocodesOnly(centres);
  const needsGeocoding = centres.filter(c => !byKey[c.centreKey]);
  if (!needsGeocoding.length || !mapboxService.isConfigured()) return byKey;

  const missing = needsGeocoding.filter(c => c.streetAddress && c.suburb && c.state);
  for (let i = 0; i < missing.length; i += GEOCODE_CONCURRENCY) {
    const batch = missing.slice(i, i + GEOCODE_CONCURRENCY);
    await Promise.all(batch.map(async (c) => {
      try {
        const addressText = `${c.streetAddress}, ${c.suburb} ${c.state}, Australia`;
        const coord = await mapboxService.geocodeAddress(addressText);
        if (!coord) return;
        byKey[c.centreKey] = coord;
        await saveGeocode(c.centreKey, coord);
      } catch {
        // one bad/unresolvable address just drops that centre from the
        // demand calc — not worth failing the whole territory view over
      }
    }));
  }
  return byKey;
}

module.exports = { getGeocodesForCentres, getCachedGeocodesOnly };
