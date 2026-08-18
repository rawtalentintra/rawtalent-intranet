// Geocodes RT centre addresses for Territory Strategy's demand-vs-supply
// matching. RT client/location records carry no lat/lng of their own
// (unlike rt_candidates_cache's addresses, which RT pre-geocodes — see
// routes/micropods.js), so this fills the same gap routePlanner.js already
// fills for leads: geocode via Mapbox once, cache permanently (a street
// address essentially never moves), top up lazily for whatever centre
// hasn't been seen yet.
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

// Returns { [centreKey]: {lat, lng} } for every centre it could place —
// centres with no usable address, or whose address Mapbox can't resolve,
// are simply absent from the result rather than failing the whole call.
async function getGeocodesForCentres(centres) {
  if (!mapboxService.isConfigured()) return {};
  const byKey = await getCachedGeocodes(centres.map(c => c.centreKey));

  const missing = centres.filter(c => !byKey[c.centreKey] && c.streetAddress && c.suburb && c.state);
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

module.exports = { getGeocodesForCentres };
