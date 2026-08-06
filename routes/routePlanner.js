const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const mapboxService = require('../services/mapboxService');
const { optimizeRoute, buildItinerary } = require('../services/routeOptimizerService');
const { emailForPartner, syncRouteToCalendar } = require('../services/leadCalendarSyncService');

router.use(requireRole('admin', 'super_admin', 'workforce_partner'));

function sleepMs(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const MAX_STOPS = 10;

// Mapbox tokens meant for browser use (public "pk." tokens, restricted by
// URL in the Mapbox dashboard) are designed to be handed to the client —
// this just gates that behind login rather than hardcoding it into a
// static JS file, consistent with the rest of this app's auth model.
router.get('/map-token', (req, res) => {
  res.json({ configured: mapboxService.isConfigured(), token: process.env.MAPBOX_ACCESS_TOKEN || null });
});

router.post('/optimize', async (req, res) => {
  try {
    const { leadIds, startAddress, departureTime } = req.body;
    if (!Array.isArray(leadIds) || !leadIds.length) return res.status(400).json({ error: 'Select at least one centre' });
    if (leadIds.length > MAX_STOPS) return res.status(400).json({ error: `Smart Routing supports up to ${MAX_STOPS} stops per run` });
    if (!startAddress?.trim()) return res.status(400).json({ error: 'Start location is required' });
    if (!departureTime) return res.status(400).json({ error: 'Departure time is required' });

    const db = getDb();
    const placeholders = leadIds.map(() => '?').join(',');
    const leadsRes = await db.execute({ sql: `SELECT * FROM leads WHERE id IN (${placeholders})`, args: leadIds });
    // Preserve the order the caller selected them in (not whatever order
    // the DB happens to return) — that's the fallback "manual" order used
    // when Mapbox isn't configured.
    const stops = leadIds.map(id => leadsRes.rows.find(l => l.id === id)).filter(Boolean);
    if (stops.length !== leadIds.length) return res.status(404).json({ error: 'One or more selected leads no longer exist' });

    if (!mapboxService.isConfigured()) {
      const itinerary = buildItinerary({
        stops, legMinutes: stops.map(() => null), legDistancesKm: null,
        departureTime, startLabel: startAddress
      });
      return res.json({ mapboxConfigured: false, order: stops.map(s => s.id), stops, itinerary });
    }

    const startCoord = await mapboxService.geocodeAddress(startAddress);
    if (!startCoord) return res.status(422).json({ error: `Could not locate "${startAddress}" — try a more specific address` });

    // Geocode is cached on the lead (latitude/longitude columns) — most
    // repeat routes won't need to re-geocode centres they've routed before.
    const geocodeFailures = [];
    for (const stop of stops) {
      if (stop.latitude != null && stop.longitude != null) continue;
      const address = [stop.street_address, stop.suburb, stop.state].filter(Boolean).join(', ') || stop.centre_name;
      const coord = await mapboxService.geocodeAddress(address);
      if (!coord) { geocodeFailures.push(stop.centre_name); continue; }
      stop.latitude = coord.lat;
      stop.longitude = coord.lng;
      await db.execute({ sql: 'UPDATE leads SET latitude = ?, longitude = ? WHERE id = ?', args: [coord.lat, coord.lng, stop.id] });
    }
    if (geocodeFailures.length) {
      return res.status(422).json({ error: `Couldn't locate: ${geocodeFailures.join(', ')} — check their address on file` });
    }

    const coords = [startCoord, ...stops.map(s => ({ lat: s.latitude, lng: s.longitude }))];
    const { durationsMinutes, distancesKm } = await mapboxService.getDistanceMatrix(coords);
    // Stamped onto each stop (index into the coords/matrix arrays above, 0
    // being the start point) so the client can recompute leg times for any
    // manual drag-to-reorder entirely locally — no need to re-hit Mapbox
    // just because the visiting order changed, the full pairwise matrix
    // already has every distance/duration it could need.
    stops.forEach((s, i) => { s.matrixIndex = i + 1; });

    const stopIndices = stops.map((_, i) => i + 1);
    const order = optimizeRoute(durationsMinutes, 0, stopIndices);
    const orderedStops = order.map(idx => stops[idx - 1]);

    const legMinutes = [];
    const legDistancesKm = [];
    let prev = 0;
    for (const idx of order) {
      legMinutes.push(durationsMinutes[prev][idx]);
      legDistancesKm.push(distancesKm[prev][idx]);
      prev = idx;
    }

    const itinerary = buildItinerary({ stops: orderedStops, legMinutes, legDistancesKm, departureTime, startLabel: startAddress });
    res.json({
      mapboxConfigured: true, order: orderedStops.map(s => s.id), stops: orderedStops, startCoord, itinerary,
      matrix: { durationsMinutes, distancesKm }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recomputes the schedule for a manually reordered stop list — no Mapbox
// calls, just re-runs the same pure itinerary builder /optimize used, over
// leg times the client already worked out from the matrix /optimize
// returned. Lets drag-to-reorder feel instant.
router.post('/reschedule', (req, res) => {
  try {
    const { stops, legMinutes, legDistancesKm, departureTime, startLabel } = req.body;
    if (!Array.isArray(stops) || !stops.length) return res.status(400).json({ error: 'No stops to schedule' });
    if (!departureTime) return res.status(400).json({ error: 'Departure time is required' });
    const itinerary = buildItinerary({
      stops,
      legMinutes: Array.isArray(legMinutes) ? legMinutes : stops.map(() => null),
      legDistancesKm: Array.isArray(legDistancesKm) ? legDistancesKm : null,
      departureTime,
      startLabel: startLabel || 'Start'
    });
    res.json({ itinerary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync-calendar', async (req, res) => {
  try {
    const { blocks } = req.body;
    if (!Array.isArray(blocks) || !blocks.length) return res.status(400).json({ error: 'No itinerary blocks to sync' });
    const firstVisit = blocks.find(b => b.type === 'visit');
    if (!firstVisit) return res.status(400).json({ error: 'Itinerary has no centre visits to sync' });
    const partnerEmail = emailForPartner(firstVisit.stop.assigned_workforce_partner);
    if (!partnerEmail) {
      return res.status(422).json({ error: `No calendar mapped for ${firstVisit.stop.assigned_workforce_partner || 'this partner'} — check CALENDAR_PARTNER_MAP` });
    }
    const created = await syncRouteToCalendar(partnerEmail, blocks);
    res.json({ success: true, created, partnerEmail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Caps how many not-yet-geocoded leads a single search will resolve via
// Mapbox (sequential HTTP calls — geocodeAddress has no batch endpoint).
// Well above what a normal filtered view returns; protects against an
// unfiltered "all leads" search turning into hundreds of blocking calls.
const MAX_GEOCODES_PER_SEARCH = 150;

// "Along My Route" — given a start and destination address, returns every
// lead within radiusKm of the straight-line path between them (a driving
// corridor approximation; see mapboxService.distanceToSegmentKm). Lets a
// workforce partner plan a route by literally describing the journey
// ("I'm starting here, ending there") instead of filtering by suburb.
router.post('/geofence', async (req, res) => {
  try {
    if (!mapboxService.isConfigured()) return res.status(422).json({ error: 'Mapbox is not configured — route-based search needs MAPBOX_ACCESS_TOKEN' });
    const { startAddress, endAddress, radiusKm } = req.body;
    if (!startAddress?.trim()) return res.status(400).json({ error: 'Start location is required' });
    if (!endAddress?.trim()) return res.status(400).json({ error: 'Destination is required' });
    const radius = Number(radiusKm) > 0 ? Number(radiusKm) : 5;

    const [startCoord, endCoord] = await Promise.all([
      mapboxService.geocodeAddress(startAddress),
      mapboxService.geocodeAddress(endAddress)
    ]);
    if (!startCoord) return res.status(422).json({ error: `Could not locate "${startAddress}" — try a more specific address` });
    if (!endCoord) return res.status(422).json({ error: `Could not locate "${endAddress}" — try a more specific address` });

    const db = getDb();
    const leadsRes = await db.execute({ sql: 'SELECT id, centre_name, street_address, suburb, state, latitude, longitude FROM leads', args: [] });
    const leads = leadsRes.rows;

    // Paced (not fired back-to-back) and individually try/caught — Mapbox's
    // geocoding rate limit is per-second, and up to MAX_GEOCODES_PER_SEARCH
    // sequential calls with no spacing was enough to trip a 429 on a single
    // search (typically the very first one, before any lead has a cached
    // coordinate). One throttled/failed lookup used to throw and abort the
    // whole search with a raw "Mapbox geocoding failed" error — now it just
    // skips that one centre and keeps going.
    let geocodeCount = 0;
    let geocodeSkipped = 0;
    for (const lead of leads) {
      if (lead.latitude != null && lead.longitude != null) continue;
      if (geocodeCount >= MAX_GEOCODES_PER_SEARCH) { geocodeSkipped++; continue; }
      if (geocodeCount > 0) await sleepMs(120);
      const address = [lead.street_address, lead.suburb, lead.state].filter(Boolean).join(', ') || lead.centre_name;
      geocodeCount++;
      let coord;
      try {
        coord = await mapboxService.geocodeAddress(address);
      } catch (err) {
        console.error(`Geofence geocode failed for lead ${lead.id} (${address}):`, err.message);
        continue;
      }
      if (!coord) continue;
      lead.latitude = coord.lat;
      lead.longitude = coord.lng;
      await db.execute({ sql: 'UPDATE leads SET latitude = ?, longitude = ? WHERE id = ?', args: [coord.lat, coord.lng, lead.id] });
    }

    const matches = leads
      .filter(l => l.latitude != null && l.longitude != null)
      .map(l => ({ id: l.id, distanceKm: mapboxService.distanceToSegmentKm({ lat: l.latitude, lng: l.longitude }, startCoord, endCoord) }))
      .filter(m => m.distanceKm <= radius)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    res.json({ matches, startCoord, endCoord, radiusKm: radius, geocodeSkipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
