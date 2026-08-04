const GEOCODE_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
const MATRIX_URL = 'https://api.mapbox.com/directions-matrix/v1/mapbox/driving';
const DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving';

function isConfigured() {
  return !!process.env.MAPBOX_ACCESS_TOKEN;
}

// Restricted to au (Australia) so a partial/ambiguous address doesn't
// silently resolve to a same-named street on the other side of the world.
async function geocodeAddress(addressText) {
  if (!isConfigured()) throw new Error('Mapbox is not configured (MAPBOX_ACCESS_TOKEN missing)');
  const query = encodeURIComponent(addressText);
  const res = await fetch(`${GEOCODE_URL}/${query}.json?country=au&limit=1&access_token=${process.env.MAPBOX_ACCESS_TOKEN}`);
  if (!res.ok) throw new Error(`Mapbox geocoding failed (${res.status})`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) return null;
  const [lng, lat] = feature.center;
  return { lat, lng };
}

// Mapbox's Matrix API takes coordinates as a single semicolon-separated
// "lng,lat;lng,lat;..." path segment, capped at 25 points on the free/pay-
// as-you-go tier — comfortably above the 8-10 stop cap this feature uses.
async function getDistanceMatrix(coords) {
  if (!isConfigured()) throw new Error('Mapbox is not configured (MAPBOX_ACCESS_TOKEN missing)');
  if (coords.length > 25) throw new Error('Too many stops for a single Matrix API request (max 25)');
  const coordsParam = coords.map(c => `${c.lng},${c.lat}`).join(';');
  const res = await fetch(`${MATRIX_URL}/${coordsParam}?annotations=distance,duration&access_token=${process.env.MAPBOX_ACCESS_TOKEN}`);
  if (!res.ok) throw new Error(`Mapbox matrix request failed (${res.status})`);
  const data = await res.json();
  // durations/distances are minutes/km, converted from the API's seconds/metres
  // up front so nothing downstream has to remember the raw units.
  return {
    durationsMinutes: data.durations.map(row => row.map(s => s / 60)),
    distancesKm: data.distances.map(row => row.map(m => m / 1000))
  };
}

// Full turn-by-turn geometry for the final ordered stop sequence, used only
// to draw the route polyline on the map — the Matrix API above is what
// actually drives the stop ordering and schedule math.
async function getDirections(coords) {
  if (!isConfigured()) throw new Error('Mapbox is not configured (MAPBOX_ACCESS_TOKEN missing)');
  const coordsParam = coords.map(c => `${c.lng},${c.lat}`).join(';');
  const res = await fetch(`${DIRECTIONS_URL}/${coordsParam}?geometries=geojson&overview=full&access_token=${process.env.MAPBOX_ACCESS_TOKEN}`);
  if (!res.ok) throw new Error(`Mapbox directions request failed (${res.status})`);
  const data = await res.json();
  return data.routes?.[0]?.geometry || null;
}

module.exports = { isConfigured, geocodeAddress, getDistanceMatrix, getDirections };
