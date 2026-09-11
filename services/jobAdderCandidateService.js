// "Find Applicants Near Centres" (2026-09-11, Joy) — the actual point of
// the JobAdder integration: an intelligent way to filter JobAdder's real
// candidate pool by qualifications AND real distance to a set of RT
// centres she picks, not just JobAdder's own city/state text search.
//
// JobAdder's Find Candidates endpoint has no radius/geo search of its own
// (confirmed directly against its OpenAPI spec, 2026-09-11) — only Name/
// Email/Phone/City/State/Location (plain text) and Keywords (full-text
// search across the candidate's own latest resume, genuinely useful for
// "Diploma"/"Certificate III"/etc. qualification filtering). So the real
// distance-to-centre computation happens here, not on JobAdder's side:
// pull a State=Victoria + Keywords-filtered slice from JobAdder (still
// text-only, but small enough to work with), geocode each candidate's
// address (cached permanently — jobadder_candidate_geocodes, same shape
// as centre_geocodes), then filter/sort by real Haversine distance to
// whichever centres were selected.
const { getDb } = require('../db/database');
const crypto = require('crypto');
const jobAdderService = require('./jobAdderService');
const mapboxService = require('./mapboxService');
const centreGeoService = require('./centreGeoService');

// The specific centres Joy named (2026-09-11) as quick-pick starting
// points — matched against real RT centre records (see this commit's own
// verification: all 10 resolved with real coordinates). Not the only
// centres selectable (the frontend also offers a plain search across
// every RT centre), just pre-populated here since these are the actual,
// current reason this feature exists ("C3 Shortage" + a few others,
// Alpha explicitly flagged by Joy as less urgent — "not entirely affected
// since they are open to ANY as long as they are from fave/reg list").
const QUICK_PICK_CENTRES = [
  { centreKey: 'loc:204', group: 'c3_shortage' },   // Nino Early Learning Adventures - Blackburn North
  { centreKey: 'loc:206', group: 'c3_shortage' },   // Nino Early Learning Adventures - Elsternwick
  { centreKey: 'loc:1867', group: 'c3_shortage' },  // Monash Caufield Childcare Centre
  { centreKey: 'loc:390', group: 'c3_shortage' },   // Wattletree Early Childhood Centre - Malvern
  { centreKey: 'loc:527', group: 'c3_shortage' },   // Richmond Creche & Kindergarten
  { centreKey: 'loc:47', group: 'c3_shortage' },    // Camberwell Kindergarten and Childcare Centre
  { centreKey: 'loc:28', group: 'other' },          // East Melbourne Child Care Co-Operative - Powlett Reserve
  { centreKey: 'loc:58', group: 'other' },          // Yarra Park Childrens Centre - East Melbourne
  { centreKey: 'loc:195', group: 'other', note: 'Not entirely affected — open to any candidate from the fave/reg list.' }, // Alpha Children's Centre & Kindergarten
  { centreKey: 'loc:1841', group: 'other' }         // Bambini Early Learning Centre - Richmond
];

// Sensible ECEC-role default so a first search returns something useful
// immediately rather than an empty/unfiltered 28k-candidate pool — Joy
// can edit or clear it. JobAdder's Keywords is a plain OR-of-terms full-
// text match against the resume, not a structured qualification field.
const DEFAULT_KEYWORDS = 'Diploma Early Childhood Certificate III Educator Childcare';

const GEOCODE_CONCURRENCY = 10;
// Safety cap on how many JobAdder candidates one search pulls before
// geocoding/distance-filtering them — keeps a broad (or empty) Keywords
// search from triggering hundreds of Mapbox geocode calls in one request.
// 500 is generously above what a real "near these specific suburbs"
// search should ever need once Keywords has narrowed things down.
const MAX_CANDIDATES_TO_SCAN = 500;
const PAGE_SIZE = 100;

function addressHash(text) {
  return crypto.createHash('sha1').update(text || '').digest('hex');
}

function formatAddress(address) {
  if (!address) return null;
  const street = Array.isArray(address.street) ? address.street.filter(Boolean).join(', ') : '';
  const parts = [street, address.city, address.state, address.postalCode].filter(Boolean);
  return parts.length ? parts.join(', ') + ', Australia' : null;
}

async function getCachedCandidateGeocode(db, candidateId, hash) {
  const res = await db.execute({
    sql: 'SELECT lat, lng FROM jobadder_candidate_geocodes WHERE candidate_id = ? AND address_hash = ?',
    args: [candidateId, hash]
  });
  return res.rows[0] || null;
}

async function saveCandidateGeocode(db, candidateId, hash, addressText, coord) {
  await db.execute({
    sql: `INSERT INTO jobadder_candidate_geocodes (candidate_id, address_hash, address_text, lat, lng, geocoded_at)
          VALUES (?, ?, ?, ?, ?, now())
          ON CONFLICT (candidate_id, address_hash) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, geocoded_at = now()`,
    args: [candidateId, hash, addressText, coord.lat, coord.lng]
  });
}

// Resolves the real RT centre records (name/suburb/lat/lng) behind
// QUICK_PICK_CENTRES — done live off the already-cached centres list
// rather than hardcoding coordinates, so a centre's real address always
// wins if it's ever corrected in RT.
async function resolveQuickPickCentres() {
  const { getCentresAndBookings } = require('../routes/centres');
  const { centres } = await getCentresAndBookings();
  const byKey = new Map(centres.map(c => [c.centreKey, c]));
  const picks = QUICK_PICK_CENTRES.map(p => ({ ...p, centre: byKey.get(p.centreKey) })).filter(p => p.centre);
  const geo = await centreGeoService.getGeocodesForCentres(picks.map(p => p.centre));
  return picks.map(p => ({
    centreKey: p.centreKey,
    name: p.centre.name,
    suburb: p.centre.suburb,
    state: p.centre.state,
    group: p.group,
    note: p.note || null,
    lat: geo[p.centreKey]?.lat ?? null,
    lng: geo[p.centreKey]?.lng ?? null
  }));
}

// General picker (not just the 10 quick-picks) — same "every RT centre,
// search by name" shape the rest of the app already offers elsewhere.
async function searchAllCentres(query) {
  const { getCentresAndBookings } = require('../routes/centres');
  const { centres } = await getCentresAndBookings();
  const q = (query || '').trim().toLowerCase();
  const matches = q.length < 2 ? [] : centres.filter(c => (c.name || '').toLowerCase().includes(q)).slice(0, 25);
  const geo = await centreGeoService.getGeocodesForCentres(matches);
  return matches.map(c => ({
    centreKey: c.centreKey, name: c.name, suburb: c.suburb, state: c.state,
    lat: geo[c.centreKey]?.lat ?? null, lng: geo[c.centreKey]?.lng ?? null
  }));
}

async function fetchCandidatePage({ accessToken, apiBaseUrl, keywords, offset }) {
  const params = new URLSearchParams({ State: 'Victoria', Limit: String(PAGE_SIZE), Offset: String(offset) });
  if (keywords && keywords.trim()) params.set('Keywords', keywords.trim());
  const res = await fetch(`${apiBaseUrl}/candidates?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`JobAdder candidate search failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

// The actual feature: pull a JobAdder-filtered slice (Victoria + Keywords),
// geocode each candidate's address (cached), keep only those within
// radiusKm of ANY selected centre, sorted by distance to their nearest one.
async function searchCandidatesNearCentres({ centreKeys, keywords, radiusKm }) {
  const token = await jobAdderService.getValidAccessToken();
  if (!token) {
    const err = new Error('JobAdder is not connected yet — visit /auth/jobadder first to authorize.');
    err.notConnected = true;
    throw err;
  }
  if (!mapboxService.isConfigured()) {
    throw new Error('Mapbox is not configured (MAPBOX_ACCESS_TOKEN missing) — needed to place candidate addresses on the map.');
  }

  const [quickPicks, extra] = await Promise.all([
    resolveQuickPickCentres(),
    (async () => {
      const knownKeys = new Set(QUICK_PICK_CENTRES.map(c => c.centreKey));
      const wanted = (centreKeys || []).filter(k => !knownKeys.has(k));
      if (!wanted.length) return [];
      const { getCentresAndBookings } = require('../routes/centres');
      const { centres } = await getCentresAndBookings();
      const byKey = new Map(centres.map(c => [c.centreKey, c]));
      const found = wanted.map(k => byKey.get(k)).filter(Boolean);
      const geo = await centreGeoService.getGeocodesForCentres(found);
      return found.map(c => ({ centreKey: c.centreKey, name: c.name, suburb: c.suburb, state: c.state, lat: geo[c.centreKey]?.lat ?? null, lng: geo[c.centreKey]?.lng ?? null }));
    })()
  ]);
  const allCentres = [...quickPicks, ...extra];
  const selected = allCentres.filter(c => (centreKeys || []).includes(c.centreKey) && c.lat != null && c.lng != null);
  if (!selected.length) {
    const err = new Error('Select at least one centre with a resolvable address.');
    err.badRequest = true;
    throw err;
  }

  const db = getDb();
  let offset = 0;
  let totalCount = null;
  const scanned = [];
  // Paginate JobAdder's own filtered results up to MAX_CANDIDATES_TO_SCAN
  // — Keywords/State narrows this from 28k+ to something workable; this
  // cap is just a hard backstop against an unfiltered/very broad search.
  while (offset < MAX_CANDIDATES_TO_SCAN) {
    const page = await fetchCandidatePage({ accessToken: token.accessToken, apiBaseUrl: token.apiBaseUrl, keywords, offset });
    totalCount = page.totalCount ?? totalCount;
    const items = page.items || [];
    scanned.push(...items);
    offset += PAGE_SIZE;
    if (items.length < PAGE_SIZE || offset >= totalCount) break;
  }

  const withAddress = scanned.filter(c => formatAddress(c.address));
  const results = [];
  for (let i = 0; i < withAddress.length; i += GEOCODE_CONCURRENCY) {
    const batch = withAddress.slice(i, i + GEOCODE_CONCURRENCY);
    await Promise.all(batch.map(async (c) => {
      const addressText = formatAddress(c.address);
      const hash = addressHash(addressText);
      let coord = await getCachedCandidateGeocode(db, c.candidateId, hash);
      if (!coord) {
        try {
          coord = await mapboxService.geocodeAddress(addressText);
          if (coord) await saveCandidateGeocode(db, c.candidateId, hash, addressText, coord);
        } catch {
          coord = null; // one unresolvable address just drops that candidate, not the whole search
        }
      }
      if (!coord) return;
      let nearest = null;
      for (const centre of selected) {
        const distanceKm = mapboxService.haversineKm(coord, centre);
        if (!nearest || distanceKm < nearest.distanceKm) nearest = { centreKey: centre.centreKey, centreName: centre.name, distanceKm };
      }
      if (nearest && nearest.distanceKm <= radiusKm) {
        results.push({
          candidateId: c.candidateId,
          name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || '(No name)',
          email: c.email || null,
          phone: c.phone || null,
          mobile: c.mobile || null,
          suburb: c.address?.city || null,
          state: c.address?.state || null,
          status: c.status?.name || null,
          updatedAt: c.updatedAt || null,
          nearestCentreName: nearest.centreName,
          distanceKm: Math.round(nearest.distanceKm * 10) / 10
        });
      }
    }));
  }
  results.sort((a, b) => a.distanceKm - b.distanceKm);
  return {
    results,
    scannedCount: scanned.length,
    totalCountAvailable: totalCount,
    hitScanCap: offset >= MAX_CANDIDATES_TO_SCAN && totalCount > MAX_CANDIDATES_TO_SCAN,
    selectedCentres: selected.map(c => ({ centreKey: c.centreKey, name: c.name }))
  };
}

module.exports = {
  QUICK_PICK_CENTRES, DEFAULT_KEYWORDS,
  resolveQuickPickCentres, searchAllCentres, searchCandidatesNearCentres
};
