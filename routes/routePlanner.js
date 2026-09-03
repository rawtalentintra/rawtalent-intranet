const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const mapboxService = require('../services/mapboxService');
const { optimizeRoute, buildItinerary } = require('../services/routeOptimizerService');
const { parseCentreKey } = require('../services/centreKeyService');
const { getDueCentreStops, getCentreStopsByKeys } = require('./centres');

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

// Live-as-you-type address suggestions for the mobile route builder's
// starting-address/manual-stop fields — see mapboxService.suggestAddresses.
router.get('/suggest-address', async (req, res) => {
  try {
    const suggestions = await mapboxService.suggestAddresses(req.query.q || '');
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolves a flat id list (lead UUIDs and/or centreKeys, order preserved)
// into full stop objects. Shared by /optimize (desktop) and /mobile-plan
// (the /wfp route builder) — pulled out of what used to be one big
// /optimize handler, same logic, unchanged behavior.
async function resolveStopsFromIds(leadIds) {
  if (!Array.isArray(leadIds) || !leadIds.length) return [];
  const db = getDb();
  // A centreKey ('loc:123'/'client:456') and a lead's UUID id are
  // trivially distinguishable via parseCentreKey (returns null for
  // anything that isn't centreKey-shaped, zero collision risk) — lets
  // the wire payload stay one flat id list instead of needing {id,type}
  // pairs from the client.
  const centreIds = leadIds.filter(id => parseCentreKey(id));
  const leadOnlyIds = leadIds.filter(id => !parseCentreKey(id));

  let leadStops = [];
  if (leadOnlyIds.length) {
    const placeholders = leadOnlyIds.map(() => '?').join(',');
    const leadsRes = await db.execute({ sql: `SELECT * FROM leads WHERE id IN (${placeholders})`, args: leadOnlyIds });
    leadStops = leadOnlyIds.map(id => leadsRes.rows.find(l => l.id === id)).filter(Boolean).map(l => ({ ...l, type: 'lead' }));
    if (leadStops.length !== leadOnlyIds.length) {
      const err = new Error('One or more selected leads no longer exist'); err.status = 404; throw err;
    }
  }

  let centreStops = [];
  if (centreIds.length) {
    // Already geocoded (or confirmed unresolvable) by getCentreStopsByKeys
    // via centreGeoService's own cache — never re-geocoded below, and
    // never written to the leads table. Doesn't re-check due-status: once
    // picked, this trusts the selection the same way a lead's pipeline
    // status is never re-validated here either.
    centreStops = await getCentreStopsByKeys(centreIds);
    if (centreStops.length !== centreIds.length) {
      const err = new Error('One or more selected centres no longer exist'); err.status = 404; throw err;
    }
  }

  // Preserve the order the caller selected them in (not whatever order
  // the DB/RT happens to return) — that's the fallback "manual" order
  // used when Mapbox isn't configured.
  const stopsById = new Map([...leadStops, ...centreStops].map(s => [s.id, s]));
  const stops = leadIds.map(id => stopsById.get(id)).filter(Boolean);
  if (stops.length !== leadIds.length) {
    const err = new Error('One or more selected stops no longer exist'); err.status = 404; throw err;
  }
  return stops;
}

// Geocodes manually-typed stops ("enter an address or suburb manually" —
// Joy's mobile route builder) into the same stop shape resolveStopsFromIds
// produces, so both flow into computeOptimizedItinerary/buildItinerary
// unchanged. Each stop is just {label, address} — address falls back to
// label when the user only typed a suburb/place name, not a full address.
async function resolveManualStops(manualStops) {
  if (!Array.isArray(manualStops) || !manualStops.length) return [];
  if (!mapboxService.isConfigured()) {
    const err = new Error('Mapbox is not configured — manually-entered stops need MAPBOX_ACCESS_TOKEN'); err.status = 422; throw err;
  }
  const resolved = [];
  for (let i = 0; i < manualStops.length; i++) {
    const m = manualStops[i] || {};
    const label = (m.label || m.address || '').toString().trim();
    if (!label) { const err = new Error('Each manually-entered stop needs an address or label'); err.status = 400; throw err; }
    const coord = await mapboxService.geocodeAddress(m.address || label);
    if (!coord) { const err = new Error(`Could not locate "${label}" — try a more specific address`); err.status = 422; throw err; }
    resolved.push({ id: `manual-${Date.now()}-${i}`, type: 'manual', centre_name: label, latitude: coord.lat, longitude: coord.lng });
  }
  return resolved;
}

// The matrix/optimize/itinerary core of what used to be all of /optimize —
// pulled out so /mobile-plan can reuse it over a stop list that mixes real
// leads/centres with manually-typed addresses. Throws {status, message}
// errors the caller turns into the same HTTP responses /optimize always
// returned; success shape is identical to /optimize's old inline response.
async function computeOptimizedItinerary({ stops, startAddress, departureTime }) {
  if (!startAddress?.trim()) { const err = new Error('Start location is required'); err.status = 400; throw err; }
  if (!departureTime) { const err = new Error('Departure time is required'); err.status = 400; throw err; }

  const db = getDb();

  if (!mapboxService.isConfigured()) {
    const itinerary = buildItinerary({
      stops, legMinutes: stops.map(() => null), legDistancesKm: null,
      departureTime, startLabel: startAddress
    });
    return { mapboxConfigured: false, order: stops.map(s => s.id), stops, itinerary };
  }

  const startCoord = await mapboxService.geocodeAddress(startAddress);
  if (!startCoord) { const err = new Error(`Could not locate "${startAddress}" — try a more specific address`); err.status = 422; throw err; }

  // Geocode is cached on the lead (latitude/longitude columns) — most
  // repeat routes won't need to re-geocode centres they've routed before.
  // Centre and manual stops are skipped entirely here — they're already
  // resolved (or already failed to resolve) by resolveStopsFromIds/
  // resolveManualStops above, neither of which is a leads row to update.
  const geocodeFailures = [];
  for (const stop of stops) {
    if (stop.latitude != null && stop.longitude != null) continue;
    if (stop.type === 'centre' || stop.type === 'manual') { geocodeFailures.push(stop.centre_name); continue; }
    const address = [stop.street_address, stop.suburb, stop.state].filter(Boolean).join(', ') || stop.centre_name;
    const coord = await mapboxService.geocodeAddress(address);
    if (!coord) { geocodeFailures.push(stop.centre_name); continue; }
    stop.latitude = coord.lat;
    stop.longitude = coord.lng;
    await db.execute({ sql: 'UPDATE leads SET latitude = ?, longitude = ? WHERE id = ?', args: [coord.lat, coord.lng, stop.id] });
  }
  if (geocodeFailures.length) {
    const err = new Error(`Couldn't locate: ${geocodeFailures.join(', ')} — check their address on file`); err.status = 422; throw err;
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
  return {
    mapboxConfigured: true, order: orderedStops.map(s => s.id), stops: orderedStops, startCoord, itinerary,
    matrix: { durationsMinutes, distancesKm }
  };
}

router.post('/optimize', async (req, res) => {
  try {
    const { leadIds, startAddress, departureTime } = req.body;
    if (!Array.isArray(leadIds) || !leadIds.length) return res.status(400).json({ error: 'Select at least one centre' });
    if (leadIds.length > MAX_STOPS) return res.status(400).json({ error: `Smart Routing supports up to ${MAX_STOPS} stops per run` });
    const stops = await resolveStopsFromIds(leadIds);
    const result = await computeOptimizedItinerary({ stops, startAddress, departureTime });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Which partner's day a mobile-plan request is for. Normally each WFP
// plans only their own day (req.user.wfp_label). An admin/super_admin (no
// wfp_label at all) or a workforce_partner granted
// can_view_all_wfp_territories (Liam — see db/schema.sql) can instead pass
// a target wfpLabel explicitly, e.g. to plan/view someone else's day. Same
// resolution shape as GET /api/leads|centres's own ?mine=true/?partnerLabel=
// (routes/leads.js, routes/centres.js) — kept consistent on purpose.
// Same guard as routes/leads.js|centres.js's own copy — `?partnerLabel=`/
// `wfpLabel` was previously trusted from any authenticated caller with no
// server-side check. Found while wiring up Gwen's second territory
// (2026-09-03, SA + QLD — see db/schema.sql's additional_wfp_territories).
function canUsePartnerLabel(user, label) {
  if (!label) return true;
  if (user.can_view_all_wfp_territories) return true;
  if (user.wfp_label === label) return true;
  return Array.isArray(user.additional_wfp_territories) && user.additional_wfp_territories.includes(label);
}
function resolveTargetWfpLabel(req) {
  const requested = (req.body && req.body.wfpLabel) || req.query.wfpLabel || null;
  if (requested && canUsePartnerLabel(req.user, requested)) return requested;
  return req.user.wfp_label || null;
}

// Saves (or overwrites) one day's planned route for a Workforce Partner —
// the "Plan a Route" screen in /wfp. Reuses the exact same
// resolve-then-optimize pipeline /optimize uses, just over a stop list that
// can also include manually-typed addresses.
router.post('/mobile-plan', async (req, res) => {
  try {
    const { routeDate, startAddress, departureTime, stops: rawStops } = req.body;
    if (!routeDate) return res.status(400).json({ error: 'A route date is required' });
    const wfpLabel = resolveTargetWfpLabel(req);
    if (!wfpLabel) return res.status(400).json({ error: 'No territory to plan for — set a Workforce Partner Territory on this account, or pick one from the filter' });

    const idStops = Array.isArray(rawStops) ? rawStops.filter(s => s && s.type !== 'manual' && s.id) : [];
    const manualStops = Array.isArray(rawStops) ? rawStops.filter(s => s && s.type === 'manual') : [];
    const totalCount = idStops.length + manualStops.length;
    if (!totalCount) return res.status(400).json({ error: 'Add at least one stop' });
    if (totalCount > MAX_STOPS) return res.status(400).json({ error: `Smart Routing supports up to ${MAX_STOPS} stops per run` });

    const [resolvedIdStops, resolvedManualStops] = await Promise.all([
      resolveStopsFromIds(idStops.map(s => s.id)),
      resolveManualStops(manualStops)
    ]);
    // Preserve the order the caller built the list in — id-typed stops keep
    // resolveStopsFromIds's own id-order guarantee; manual stops are
    // spliced back in at their original position rather than appended,
    // since the mobile builder lets stops of either kind be interleaved.
    const idStopsById = new Map(resolvedIdStops.map(s => [s.id, s]));
    let manualCursor = 0;
    const stops = rawStops.map(s => {
      if (s.type === 'manual') return resolvedManualStops[manualCursor++];
      return idStopsById.get(s.id);
    }).filter(Boolean);

    const result = await computeOptimizedItinerary({ stops, startAddress, departureTime });

    const db = getDb();
    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO wfp_planned_routes (id, wfp_label, route_date, start_address, departure_time, stops, itinerary, created_by_email, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())
            ON CONFLICT (wfp_label, route_date) DO UPDATE SET
              start_address = excluded.start_address, departure_time = excluded.departure_time,
              stops = excluded.stops, itinerary = excluded.itinerary,
              created_by_email = excluded.created_by_email, updated_at = now()`,
      args: [id, wfpLabel, routeDate, startAddress || null, departureTime || null, JSON.stringify(result.stops), JSON.stringify(result.itinerary), req.user.email]
    });

    res.json({ ...result, wfpLabel, routeDate });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Returns the saved plan for one partner/day (Today's "Your Route Today"),
// or { plan: null } if nothing has been built yet for that date.
router.get('/mobile-plan', async (req, res) => {
  try {
    const routeDate = req.query.date;
    if (!routeDate) return res.status(400).json({ error: 'A date is required' });
    const wfpLabel = resolveTargetWfpLabel(req);
    if (!wfpLabel) return res.json({ plan: null });

    const db = getDb();
    const result = await db.execute({
      sql: 'SELECT * FROM wfp_planned_routes WHERE wfp_label = ? AND route_date = ?',
      args: [wfpLabel, routeDate]
    });
    const row = result.rows[0];
    if (!row) return res.json({ plan: null });
    res.json({
      plan: {
        routeDate: row.route_date, startAddress: row.start_address, departureTime: row.departure_time,
        stops: row.stops, itinerary: row.itinerary, updatedAt: row.updated_at
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clears a bad/outdated plan so the day can be rebuilt from scratch.
router.delete('/mobile-plan', async (req, res) => {
  try {
    const routeDate = req.query.date;
    if (!routeDate) return res.status(400).json({ error: 'A date is required' });
    const wfpLabel = resolveTargetWfpLabel(req);
    if (!wfpLabel) return res.status(400).json({ error: 'No territory to clear' });
    const db = getDb();
    await db.execute({ sql: 'DELETE FROM wfp_planned_routes WHERE wfp_label = ? AND route_date = ?', args: [wfpLabel, routeDate] });
    res.json({ success: true });
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

// POST /sync-calendar (pushing itinerary blocks to each partner's Google
// Calendar via the API) removed along with the whole Calendar Sync
// subsystem — Joy, 2026-09-03: too much trouble for what it delivered.
// Smart Routing's timeline now gives each visit block its own client-side
// "Add to Calendar" link instead (views/admin.html's renderRouteResults,
// using the same no-backend Google quick-add URL trick used for leads/
// centres — buildGoogleCalendarQuickAddUrl).

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

    const leadMatches = leads
      .filter(l => l.latitude != null && l.longitude != null)
      .map(l => ({ id: l.id, type: 'lead', distanceKm: mapboxService.distanceToSegmentKm({ lat: l.latitude, lng: l.longitude }, startCoord, endCoord) }))
      .filter(m => m.distanceKm <= radius);

    // Due centres are already geocoded (centreGeoService's own permanent
    // cache) — no per-search geocode loop needed here the way leads above
    // still has one. Recomputes health+nurture for the live centre list on
    // every search (same "recomputed on every read, never a stored value
    // that can drift" posture as centreHealthService itself); everything
    // it reads is already cached (getCentresAndBookings ~5min,
    // centre_geocodes permanently), so this stays fast in practice.
    const dueCentres = await getDueCentreStops();
    const centreMatches = dueCentres
      .filter(c => c.latitude != null && c.longitude != null)
      .map(c => ({ id: c.id, type: 'centre', distanceKm: mapboxService.distanceToSegmentKm({ lat: c.latitude, lng: c.longitude }, startCoord, endCoord) }))
      .filter(m => m.distanceKm <= radius);

    const matches = [...leadMatches, ...centreMatches].sort((a, b) => a.distanceKm - b.distanceKm);

    res.json({ matches, startCoord, endCoord, radiusKm: radius, geocodeSkipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
