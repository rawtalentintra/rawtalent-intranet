const GEOCODE_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
const MATRIX_URL = 'https://api.mapbox.com/directions-matrix/v1/mapbox/driving';
const DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving';

function isConfigured() {
  return !!process.env.MAPBOX_ACCESS_TOKEN;
}

// Restricted to au (Australia) so a partial/ambiguous address doesn't
// silently resolve to a same-named street on the other side of the world.
//
// types=address,poi stops Mapbox from ever falling back to a coarse
// suburb/postcode/region-centroid match when it can't confidently place
// the exact address — previously nothing here rejected that, and it's
// the likely cause of a real reported bug (2026-09-01): a centre's pin
// on the Smart Routing map landing in the wrong part of Melbourne
// entirely. relevance is a second, belt-and-suspenders check for the
// rarer case where even an address/poi match is a weak one — both
// failure modes are treated the same as "couldn't geocode this one",
// which every caller here already handles gracefully (drops that one
// stop/centre rather than showing a wrong location, or failing outright).
async function geocodeAddress(addressText) {
  if (!isConfigured()) throw new Error('Mapbox is not configured (MAPBOX_ACCESS_TOKEN missing)');
  const query = encodeURIComponent(addressText);
  const res = await fetch(`${GEOCODE_URL}/${query}.json?country=au&types=address,poi&limit=1&access_token=${process.env.MAPBOX_ACCESS_TOKEN}`);
  if (!res.ok) throw new Error(`Mapbox geocoding failed (${res.status})`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) return null;
  if (typeof feature.relevance === 'number' && feature.relevance < 0.5) return null;
  const [lng, lat] = feature.center;
  return { lat, lng };
}

// Address autocomplete for the /wfp mobile route builder ("is there no
// auto-complete here... like Google" — Joy, 2026-09-03). Same geocoding
// endpoint geocodeAddress uses, just with autocomplete=true and multiple
// results instead of a single best match — Mapbox's own answer to
// Google Places Autocomplete, no separate API/key needed. Deliberately
// forgiving on input (returns [] rather than throwing) since this drives
// a live-as-you-type dropdown — a bad keystroke or a momentary network
// blip should just show no suggestions, not surface an error toast.
async function suggestAddresses(query) {
  if (!isConfigured() || !query || query.trim().length < 3) return [];
  const q = encodeURIComponent(query.trim());
  try {
    const res = await fetch(`${GEOCODE_URL}/${q}.json?country=au&types=address,poi&autocomplete=true&limit=5&access_token=${process.env.MAPBOX_ACCESS_TOKEN}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.features || []).map(f => ({ label: f.place_name, lat: f.center[1], lng: f.center[0] }));
  } catch {
    return [];
  }
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

const EARTH_RADIUS_KM = 6371;
function toRad(deg) { return (deg * Math.PI) / 180; }

// Haversine, in km — accurate enough for the sub-few-hundred-km spans this
// app deals with (route corridor search, single point-to-point checks).
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

// Shortest distance from `point` to the straight-line segment start→end, in
// km. Coordinates are projected onto a local flat plane (equirectangular,
// centred on the segment) before doing ordinary point-to-segment geometry —
// simple and plenty accurate at the city/regional scale a driving corridor
// search needs; a full great-circle segment projection would be overkill.
function distanceToSegmentKm(point, start, end) {
  const latRef = toRad((start.lat + end.lat) / 2);
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos(latRef);
  const project = (p) => ({ x: p.lng * kmPerDegLng, y: p.lat * kmPerDegLat });
  const p = project(point), a = project(start), b = project(end);
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx, cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

module.exports = { isConfigured, geocodeAddress, suggestAddresses, getDistanceMatrix, getDirections, haversineKm, distanceToSegmentKm };
