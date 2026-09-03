const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin, requireSuperAdmin, requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const rtApi = require('../services/rtApiReportService');
const centreMatchService = require('../services/centreMatchService');
const { keyForLocation, keyForClient } = require('../services/centreKeyService');
const { MEANINGFUL_BOOKING_STATUSES } = require('../services/centreHealthService');
const { visitsByCentreKey, getCentresAndBookings } = require('./centres');
const { BUCKETS, uploadBuffer, downloadAsBuffer, remove: removeFile, extForMimetype, ensureBucket, setFileResponseHeaders } = require('../services/storageService');
const { partnerForSuburbState } = require('../services/melbourneTerritoryService');
const mapboxService = require('../services/mapboxService');
const leadRegionService = require('../services/leadRegionService');
const groqTranscription = require('../services/groqTranscriptionService');
const { analyzeVisitFromTranscript } = require('../services/centreVisitAnalysisService');

router.use(requireAuth);

// Any format — a site-visit recording could be a phone-app voice memo, a
// Zoom/Teams export, whatever the Workforce Partner actually captured, so
// no mimetype allowlist. 200MB covers a real video export; well above the
// 20MB project-file cap since this is often audio/video, not a document.
const leadRecordingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// qa_view gets read-only access to the admin Leads list/detail (not the
// Sales Dashboard, which reuses this same data client-side but is kept
// off qa_view's nav for now). workforce_partner gets both Leads and Sales
// Dashboard, plus limited edit rights — see PUT /:id below.
const leadsViewAccess = requireRole('admin', 'super_admin', 'qa_view', 'workforce_partner');

// State -> Workforce Partner auto-assignment. Still overridable afterwards
// via PUT — this just sets a sensible default so nothing sits unassigned.
// VIC is further split by suburb (Liam's north/west vs Justine's
// east/south-east/bayside directive, 2026-08-22) via
// melbourneTerritoryService — this map now only covers non-VIC states.
const STATE_WORKFORCE_PARTNER = {
  SA: 'Gwen Stocks (SA)',
  QLD: 'Gwen Stocks (QLD)' // Gwen's second territory (Liam, 2026-09-03) — see db/schema.sql's additional_wfp_territories comment
};

function autoAssignWorkforcePartner(suburb, state) {
  return partnerForSuburbState(suburb, state) || STATE_WORKFORCE_PARTNER[state] || null;
}

// `?partnerLabel=` was previously accepted from any authenticated caller
// with no server-side check at all — only the frontend hiding the picker
// for a plain workforce_partner login (views/wfp.html's wfpFilterBarHtml)
// stopped them from hand-crafting a request for someone else's territory.
// Found while wiring up Gwen's second territory (2026-09-03) — this is
// the same duplicated-per-file small-helper pattern STATE_WORKFORCE_PARTNER
// itself already uses (see routes/centres.js's own copy).
function canUsePartnerLabel(user, label) {
  if (!label) return true;
  if (user.can_view_all_wfp_territories) return true;
  if (user.wfp_label === label) return true;
  return Array.isArray(user.additional_wfp_territories) && user.additional_wfp_territories.includes(label);
}

// Strips label noise that's been landing in street_address — "Address: 39
// Smith St" instead of just "39 Smith St" (found live 2026-08-24, traced
// from a real Smart Routing bug: Liam saw a Frankston lead's map pin sit
// ~40km off near inner Melbourne, and its stored address turned out to
// literally start with "Address: "). Confirmed 18 existing leads had this
// same "Address:" label baked into the field, almost certainly pasted
// straight from whatever source these leads come from — geocoding
// "Address: 39–41 Rubenina St, Frankston VIC" sends Mapbox a garbage
// token ("Address") ahead of the real street name, which is enough to
// throw off which result it picks as the best match. Also normalises an
// en-dash in house-number ranges ("39–41") to a plain hyphen, seen in the
// same contaminated rows — real addresses don't use that character, it's
// copy-paste noise from wherever these values originated.
function sanitizeStreetAddress(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();
  const idx = s.toLowerCase().lastIndexOf('address:');
  if (idx !== -1) s = s.slice(idx + 'address:'.length).trim();
  s = s.replace(/[‒–—−]/g, '-');
  return s || null;
}

// Best-effort geocode + metro/regional classification for one address —
// used both at lead-creation time and by the backfill endpoint below.
// Never throws: a bad/unresolvable address (or Mapbox not configured,
// e.g. locally) just leaves the lead unclassified (is_regional stays
// NULL) rather than blocking creation — same tolerance every other
// geocoding call site in this app already uses.
async function geocodeAndClassify(streetAddress, suburb, state) {
  if (!streetAddress || !suburb || !state || !mapboxService.isConfigured()) {
    return { lat: null, lng: null, isRegional: null };
  }
  try {
    const coord = await mapboxService.geocodeAddress(`${streetAddress}, ${suburb} ${state}, Australia`);
    if (!coord) return { lat: null, lng: null, isRegional: null };
    return { lat: coord.lat, lng: coord.lng, isRegional: leadRegionService.isRegional(state, coord.lat, coord.lng) };
  } catch {
    return { lat: null, lng: null, isRegional: null };
  }
}

// Anyone signed in can submit — consultant identity is always the caller,
// never a field the client can set, so a lead can't be logged under
// someone else's name by mistake or on purpose.
router.post('/', async (req, res) => {
  try {
    const {
      centreName, streetAddress, suburb, state, centrePhone,
      educatorName, agencyName, numberOfShifts, agencyUsage, position,
      contactFirstName, contactLastName, contactEmail, entryType
    } = req.body;
    if (!centreName?.trim()) return res.status(400).json({ error: 'Centre name is required' });
    if (!streetAddress?.trim()) return res.status(400).json({ error: 'Street address is required' });
    if (!centrePhone?.trim()) return res.status(400).json({ error: 'Centre phone number is required' });
    if (!agencyUsage) return res.status(400).json({ error: 'Agency usage is required' });

    const id = uuidv4();
    const assignedWorkforcePartner = autoAssignWorkforcePartner(suburb, state);
    // Defaults to 'lead' (a consultant's vetting-call submission) unless the
    // Leads table's "Add Centre" button explicitly says otherwise — that's
    // the only caller that should ever send 'centre'.
    const resolvedEntryType = entryType === 'centre' ? 'centre' : 'lead';
    const cleanStreetAddress = sanitizeStreetAddress(streetAddress);
    const { lat, lng, isRegional } = await geocodeAndClassify(cleanStreetAddress, suburb, state);
    await getDb().execute({
      sql: `INSERT INTO leads (
              id, centre_name, street_address, suburb, state, centre_phone,
              educator_name, agency_name, number_of_shifts, agency_usage, position,
              contact_first_name, contact_last_name, contact_email,
              submitted_by_email, submitted_by_name, assigned_workforce_partner, entry_type,
              latitude, longitude, is_regional, archived_at, archived_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, centreName.trim(), cleanStreetAddress, suburb?.trim() || null, state || null, centrePhone?.trim() || null,
        educatorName?.trim() || null, agencyName?.trim() || null, numberOfShifts?.trim() || null, agencyUsage || null, position || null,
        contactFirstName?.trim() || null, contactLastName?.trim() || null, contactEmail?.trim() || null,
        req.user.email, req.user.name || req.user.email, assignedWorkforcePartner, resolvedEntryType,
        lat, lng, isRegional, isRegional ? new Date().toISOString() : null, isRegional ? 'regional' : null
      ]
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// My own submissions — so a consultant can see what they've logged, same
// pattern as "My Requests" on Leave.
router.get('/mine', async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT * FROM leads WHERE LOWER(submitted_by_email) = LOWER(?) ORDER BY created_at DESC',
      args: [req.user.email]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// `?mine=true` (the /wfp mobile app, 2026-09-03) — a real backend
// territory filter, not just the client-side partner-picker every other
// Leads view still uses. Falls back to the same suburb/state default
// (partnerForSuburbState) centres use for the handful of leads with no
// explicit assignment. No-ops when the caller has no wfp_label —
// admin/super_admin, or any workforce_partner account that hasn't had it
// set yet, still get everything rather than an empty list.
// `?partnerLabel=<label>` (2026-09-03) — the SAME filter, explicit label
// instead of the caller's own wfp_label. For /wfp's own admin-facing
// territory toggle (Joy: "add the filters... similar to what we have on
// the Desktop app", but only shown there to a caller with no wfp_label of
// their own — a real Workforce Partner never gets a picker at all, still
// always auto-scoped via ?mine=true). Reuses this exact filter rather
// than a second client-side reimplementation, so it can't drift out of
// sync with what ?mine=true itself considers "this partner's leads".
// `mine` wins if somehow both are sent.
router.get('/', leadsViewAccess, async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM leads ORDER BY created_at DESC');
    let rows = result.rows;
    const targetLabel = req.query.mine === 'true' ? req.user.wfp_label : (req.query.partnerLabel || null);
    if (targetLabel && !canUsePartnerLabel(req.user, targetLabel)) return res.status(403).json({ error: 'Not authorized for this territory' });
    if (targetLabel) {
      rows = rows.filter(l => (l.assigned_workforce_partner || partnerForSuburbState(l.suburb, l.state)) === targetLabel);
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-time (and safety-net) classification pass for leads that predate
// this feature, or whose address failed to geocode at creation time
// (Mapbox down, address unresolvable, etc.) — only ever touches rows
// that have never been classified (is_regional IS NULL), so a lead a
// human has since manually unarchived (still is_regional=true,
// archived_at cleared) is never silently re-archived by a later run of
// this. Admin-only since it makes real writes and costs real Mapbox
// geocoding calls, not something to expose to every leads-view role.
router.post('/backfill-regions', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.execute({
      sql: `SELECT id, street_address, suburb, state, latitude, longitude FROM leads WHERE is_regional IS NULL`,
      args: []
    })).rows;
    let classified = 0, archived = 0, skipped = 0;
    for (const row of rows) {
      // Reuse coordinates Smart Routing already geocoded for this lead
      // (most real leads have these — see leads.latitude/longitude's own
      // comment) instead of spending a fresh Mapbox call on every row.
      let lat = row.latitude, lng = row.longitude;
      if (lat == null || lng == null) {
        const geo = await geocodeAndClassify(row.street_address, row.suburb, row.state);
        lat = geo.lat; lng = geo.lng;
      }
      const isRegional = leadRegionService.isRegional(row.state, lat, lng);
      if (isRegional === null) { skipped++; continue; }
      classified++;
      if (isRegional) archived++;
      await db.execute({
        sql: `UPDATE leads SET latitude = ?, longitude = ?, is_regional = ?,
                archived_at = ?, archived_reason = ? WHERE id = ?`,
        args: [lat, lng, isRegional, isRegional ? new Date().toISOString() : null, isRegional ? 'regional' : null, row.id]
      });
    }
    res.json({ totalChecked: rows.length, classified, archived, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual restore — "recoverable when we start going out to regional
// areas" (Liam, 2026-08-24). Deliberately doesn't reset is_regional back
// to false/null: it's still, factually, outside the metro radius; this
// only clears the archive so it shows in the main view again, same
// distinction as a closed lead being reopened.
router.post('/:id/unarchive', leadsViewAccess, async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: `UPDATE leads SET archived_at = NULL, archived_reason = NULL WHERE id = ?`,
      args: [req.params.id]
    });
    if (!result.rowsAffected) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RT has no field connecting a booking/client back to "the lead that
// created this centre" (see services/centreMatchService.js), so "does this
// lead already exist as a real centre" can only be answered by matching
// name/phone/suburb/state after the fact — computed here rather than
// client-side since it needs RT's raw client/location data, not the
// already-flattened shape /api/centres returns. Kept as its own endpoint
// (not folded into GET /) so the main leads list stays cheap for callers
// that don't need this.
let leadsMatchClientsCache = { clients: null, expiresAt: 0 };
const LEADS_MATCH_CLIENTS_TTL_MS = 5 * 60 * 1000;
async function getClientsForMatching() {
  if (leadsMatchClientsCache.clients && Date.now() < leadsMatchClientsCache.expiresAt) return leadsMatchClientsCache.clients;
  const clients = await rtApi.fetchAllPages('clients', {});
  leadsMatchClientsCache = { clients, expiresAt: Date.now() + LEADS_MATCH_CLIENTS_TTL_MS };
  return clients;
}

router.get('/existing-centre-matches', leadsViewAccess, async (req, res) => {
  try {
    const leadsRows = (await getDb().execute('SELECT id, centre_name, centre_phone, suburb, state FROM leads')).rows;
    const clients = await getClientsForMatching();
    const matches = {};
    for (const lead of leadsRows) {
      const match = centreMatchService.findConfidentMatch(lead, clients);
      if (match) matches[lead.id] = match;
    }
    res.json(matches);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Client Retention — "did our actions lead to activation, booking growth
// and retention" for every lead that actually signed. A signed lead has no
// persisted link to its real RT client/location (leads.rt_client_id/
// rt_location_id exist in the schema but nothing writes them today — see
// db/schema.sql), so this uses the same best-effort name/phone/suburb
// match as the "Existing Centre?" column (centreMatchService) rather than
// requiring that link to exist first. A lead that doesn't clear the
// confidence bar is reported as unmatched, never given fabricated numbers.
router.get('/retention', leadsViewAccess, async (req, res) => {
  try {
    const signedLeads = (await getDb().execute("SELECT * FROM leads WHERE signed_status = 'signed' ORDER BY signed_at DESC")).rows;
    if (!signedLeads.length) return res.json([]);

    const clients = await getClientsForMatching();
    const matched = signedLeads.map(lead => ({ lead, match: centreMatchService.findConfidentMatch(lead, clients) }));

    // RT has no per-client booking filter (see routes/centres.js), so
    // fetching "since the oldest signed lead" is one bulk pull regardless
    // of how many signed leads exist — capped so one very old signed
    // centre can't force pulling years of RT booking history.
    const RETENTION_LOOKBACK_CAP_DAYS = 730;
    const oldestSignedAt = matched.reduce((min, m) => new Date(m.lead.signed_at) < min ? new Date(m.lead.signed_at) : min, new Date());
    const daysBack = Math.min(RETENTION_LOOKBACK_CAP_DAYS, Math.ceil((Date.now() - oldestSignedAt.getTime()) / 86400000) + 5);
    const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const bookings = await rtApi.fetchAllPages('bookings', { startDate });

    const centreKeys = matched.filter(m => m.match).map(m => m.match.rtLocationId ? keyForLocation(m.match.rtLocationId) : keyForClient(m.match.rtClientId));
    const visits = await visitsByCentreKey(centreKeys);

    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const results = matched.map(({ lead, match }) => {
      const base = { leadId: lead.id, centreName: lead.centre_name, suburb: lead.suburb, state: lead.state, signedAt: lead.signed_at };
      if (!match) return { ...base, matched: false };

      const centreKey = match.rtLocationId ? keyForLocation(match.rtLocationId) : keyForClient(match.rtClientId);
      const centreBookings = bookings.filter(b =>
        MEANINGFUL_BOOKING_STATUSES.has(b.statusId) && b.bookingDate &&
        (match.rtLocationId ? b.locationId === match.rtLocationId : b.clientId === match.rtClientId)
      );
      const signedAtMs = new Date(lead.signed_at).getTime();
      const bookingsSinceSigned = centreBookings.filter(b => new Date(b.bookingDate).getTime() >= signedAtMs).length;
      const bookings30d = centreBookings.filter(b => now - new Date(b.bookingDate).getTime() <= 30 * DAY_MS).length;
      const bookingsPrev30d = centreBookings.filter(b => {
        const age = now - new Date(b.bookingDate).getTime();
        return age > 30 * DAY_MS && age <= 60 * DAY_MS;
      }).length;
      const centreVisits = visits[centreKey] || []; // already DESC by visit_date
      const lastVisit = centreVisits[0]?.visit_date || null;
      const nextStepDueDate = centreVisits.find(v => v.next_step_due_date)?.next_step_due_date || null;

      return {
        ...base,
        matched: true,
        matchedClientName: match.clientName,
        centreKey,
        retainedDays: Math.floor((now - signedAtMs) / DAY_MS),
        bookingsSinceSigned,
        bookings30d,
        bookingsPrev30d,
        lastVisitDate: lastVisit,
        nextStepDueDate
      };
    });

    res.json(results);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Feeds the compact VIC/SA performance charts — counts per stage, scoped to
// a date range the client computes (this week / this month / arbitrary
// month), so the chart logic stays purely in SQL and the frontend just picks
// the range.
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const conditions = ['state IN (?, ?)'];
    const args = ['SA', 'VIC'];
    if (from) { conditions.push('created_at >= ?'); args.push(from); }
    if (to) { conditions.push('created_at < ?'); args.push(to); }

    const result = await getDb().execute({
      sql: `SELECT state,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE lead_called_status = 'done') AS called,
              COUNT(*) FILTER (WHERE centre_visited_status = 'done') AS visited,
              COUNT(*) FILTER (WHERE signed_status = 'signed') AS signed
            FROM leads
            WHERE ${conditions.join(' AND ')}
            GROUP BY state`,
      args
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fuzzy duplicate check for the submission form — reps type centre names
// and addresses inconsistently ("Goodstart Caulfield" vs "Goodstart Early
// Learning Caulfield"), so an exact-match lookup would miss most repeats.
// Open to any authed user (not just admins), since it's the rep filling out
// the form who needs the warning before wasting time on the rest of it.
// Decision Area 5 (Client acquisition and activation, 2026-08-22) asked
// for an approval/duplicate-check step during centre creation — this
// endpoint only ever checked a new lead against OTHER LEADS, never
// against RT's real, live client list, so the actual highest-value
// duplicate case (someone spending time on a "lead" that's already a
// paying, signed client) was never caught here at all. Reuses
// centreMatchService's exact fuzzy name/phone/suburb/state matching —
// the SAME logic already used after the fact for the Leads list's
// "Existing Centre?" column and leadAutoSignService's auto-detection —
// so a new lead gets the identical duplicate-risk signal at creation
// time, not just once someone happens to look later.
router.get('/check-duplicate', async (req, res) => {
  try {
    const centreName = (req.query.centreName || '').trim();
    const streetAddress = (req.query.streetAddress || '').trim();
    const suburb = (req.query.suburb || '').trim();
    const state = (req.query.state || '').trim();
    const centrePhone = (req.query.centrePhone || '').trim();

    const centreMatches = centreName.length >= 3
      ? await getDb().execute({
          sql: `SELECT id, centre_name, street_address, suburb, state, submitted_by_name, created_at, signed_status,
                       similarity(lower(centre_name), lower(?)) AS score
                FROM leads
                WHERE similarity(lower(centre_name), lower(?)) > 0.3
                ORDER BY score DESC LIMIT 3`,
          args: [centreName, centreName]
        }).then(r => r.rows)
      : [];

    const addressMatches = streetAddress.length >= 5
      ? await getDb().execute({
          sql: `SELECT id, centre_name, street_address, suburb, state, submitted_by_name, created_at, signed_status,
                       similarity(lower(street_address), lower(?)) AS score
                FROM leads
                WHERE street_address IS NOT NULL AND similarity(lower(street_address), lower(?)) > 0.35
                ORDER BY score DESC LIMIT 3`,
          args: [streetAddress, streetAddress]
        }).then(r => r.rows)
      : [];

    let rtClientMatch = null;
    if (centreName.length >= 3 || centrePhone.length >= 6) {
      const { rawClients } = await getCentresAndBookings();
      const pseudoLead = { centre_name: centreName, centre_phone: centrePhone, suburb, state };
      // findConfidentMatch, not findMatches — the same confidence bar
      // every other consumer of this service uses (the Leads list's
      // "Existing Centre?" column, leadAutoSignService). Verified live:
      // a plain name-token overlap on generic words like "Children's
      // Centre" alone clears a naive score-based threshold without
      // actually being the right centre — confident requires a phone
      // match, or name+suburb together, which is a real signal.
      const best = centreMatchService.findConfidentMatch(pseudoLead, rawClients);
      if (best) {
        rtClientMatch = {
          centreKey: best.rtLocationId ? keyForLocation(best.rtLocationId) : keyForClient(best.rtClientId),
          clientName: best.clientName, locationLabel: best.locationLabel,
          reasons: best.reasons, confident: best.confident
        };
      }
    }

    res.json({ centreMatches, addressMatches, rtClientMatch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', leadsViewAccess, async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Contact fields are deliberately left blank on submission now — the
// Workforce Partner fills them in themselves after they've spoken to the
// centre, from the Leads list in their own view. workforce_partner also
// gets the call/visit/sign status+date fields — they're the ones actually
// making the calls and visits, so locking them out of marking that as
// done was the wrong call (confirmed with Joy 2026-08-13, in response to
// a real report from Gwen that she couldn't update Lead Called). Lead
// *assignment* (which Workforce Partner a lead belongs to) stays a
// separate, admin/super_admin-only concern below, along with the original
// submission fields in case something was mistyped.
const WORKFORCE_PARTNER_FIELDS = {
  position: 'position', contact_first_name: 'contactFirstName', contact_last_name: 'contactLastName', contact_email: 'contactEmail',
  lead_called_status: 'leadCalledStatus', lead_called_at: 'leadCalledAt',
  centre_visited_status: 'centreVisitedStatus', centre_visited_at: 'centreVisitedAt',
  signed_status: 'signedStatus', signed_at: 'signedAt'
};
const ADMIN_FIELDS = {
  centre_name: 'centreName', street_address: 'streetAddress', suburb: 'suburb', state: 'state', centre_phone: 'centrePhone',
  educator_name: 'educatorName', agency_name: 'agencyName', number_of_shifts: 'numberOfShifts', agency_usage: 'agencyUsage',
  ...WORKFORCE_PARTNER_FIELDS,
  assigned_workforce_partner: 'assignedWorkforcePartner'
};

router.put('/:id', requireRole('admin', 'super_admin', 'workforce_partner'), async (req, res) => {
  try {
    const existing = await getDb().execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    // Lead Called is optional — visiting a centre without a prior logged
    // call is a valid path, so a visit already done OR already scheduled
    // shouldn't leave Lead Called sitting at its default To Schedule
    // looking like an outstanding task (once a visit is on the calendar,
    // there's nothing left for a call to accomplish first). Only kicks in
    // when Lead Called hasn't been engaged with at all (still To Schedule,
    // whether that's the existing value or this same request is itself
    // trying to set it there) — never overrides Called/Scheduled/N/A a
    // person actually chose. Injected into req.body before the field loop
    // below so it's picked up the normal way, same as every other field.
    if (req.body.centreVisitedStatus === 'done' || req.body.centreVisitedStatus === 'scheduled') {
      const wouldBeCalledStatus = 'leadCalledStatus' in req.body ? req.body.leadCalledStatus : existing.rows[0].lead_called_status;
      if (wouldBeCalledStatus === 'to_schedule') req.body.leadCalledStatus = 'n_a';
    }

    const fields = req.user.role === 'workforce_partner' ? WORKFORCE_PARTNER_FIELDS : ADMIN_FIELDS;
    const sets = [];
    const args = [];
    for (const [column, bodyKey] of Object.entries(fields)) {
      if (bodyKey in req.body) {
        sets.push(`${column} = ?`);
        args.push(column === 'street_address' ? sanitizeStreetAddress(req.body[bodyKey]) : (req.body[bodyKey] || null));
      }
    }
    // A corrected street_address/suburb/state makes the cached lat/lng
    // stale — routePlanner.js only re-geocodes a lead when its coordinates
    // are null, so without this an address fix would silently keep
    // routing off the old (possibly wrong) location until someone
    // happened to clear it by hand.
    if ('streetAddress' in req.body || 'suburb' in req.body || 'state' in req.body) {
      sets.push('latitude = NULL', 'longitude = NULL');
    }
    // A lead reaching Profile Created is done, full stop — auto-close it
    // the same way the manual "Close Lead" button already does, instead of
    // leaving every signed lead sitting in the active list forever until
    // someone remembers to close it by hand. Never overwrites an existing
    // closed_at (e.g. a lead someone already closed for an unrelated
    // reason before later marking it signed) — this only fires the first
    // time signing happens.
    if (req.body.signedStatus === 'signed' && !existing.rows[0].closed_at) {
      sets.push('closed_at = ?', 'closed_by_email = ?');
      args.push(new Date().toISOString(), req.user.email);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    args.push(req.params.id);
    await getDb().execute({ sql: `UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = ?`, args });

    const result = await getDb().execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [req.params.id] });
    const updated = result.rows[0];
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Close out" a lead — covers both "fully done, Profile Created, nothing
// left to track" and "this one's dead, stop chasing it". Kept as its own
// endpoint rather than folded into the generic field-mapping PUT above,
// since closed_at/closed_by_email need to come from the server session,
// not a client-supplied value. Reopening (closed: false) just clears
// all three columns — nothing else about the lead is touched either way.
// `reason` (2026-09-03, the /wfp mobile app's Closed/Lost stage) is
// optional and only ever written when closing — the auto-close on
// signed_status='signed' elsewhere in this file never passes one, since
// that path is a win, not a loss, and has nothing to explain.
router.patch('/:id/closed', requireRole('admin', 'super_admin', 'workforce_partner'), async (req, res) => {
  const { closed, reason } = req.body;
  if (typeof closed !== 'boolean') return res.status(400).json({ error: 'closed must be a boolean' });
  try {
    const existing = await getDb().execute({ sql: 'SELECT id FROM leads WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    await getDb().execute({
      sql: 'UPDATE leads SET closed_at = ?, closed_by_email = ?, closed_reason = ?, updated_at = now() WHERE id = ?',
      args: [closed ? new Date().toISOString() : null, closed ? req.user.email : null, closed ? (reason || null) : null, req.params.id]
    });
    const result = await getDb().execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [req.params.id] });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clears the "needs review" state on an auto-signed lead once a Workforce
// Partner has actually looked at it and followed up (or confirmed there's
// nothing left to do) — auto_signed itself stays true forever as a record
// of how the lead was signed, this just tracks that a human has seen it.
// Own endpoint rather than folded into the generic PUT above since
// reviewed_at/by need to come from the server session, same reasoning as
// closed_at/closed_by_email on PATCH /:id/closed.
router.patch('/:id/acknowledge-auto-sign', requireRole('admin', 'super_admin', 'workforce_partner'), async (req, res) => {
  try {
    const existing = await getDb().execute({ sql: 'SELECT id, auto_signed FROM leads WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    if (!existing.rows[0].auto_signed) return res.status(400).json({ error: 'This lead was not auto-signed' });
    await getDb().execute({
      sql: 'UPDATE leads SET auto_signed_reviewed_at = now(), auto_signed_reviewed_by = ?, updated_at = now() WHERE id = ?',
      args: [req.user.email, req.params.id]
    });
    const result = await getDb().execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [req.params.id] });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deleting a lead outright (not just marking a status) is destructive and
// affects Sales Dashboard/WFP Dashboard totals, so it's kept to the single
// super_admin account rather than opened to all admins.
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    const existing = await getDb().execute({ sql: 'SELECT id FROM leads WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    await getDb().execute({ sql: 'DELETE FROM lead_notes WHERE lead_id = ?', args: [req.params.id] });
    await getDb().execute({ sql: 'DELETE FROM leads WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Notes thread on a lead — readable by anyone with leads view access
// (admin/super_admin/qa_view/workforce_partner). Postable by any
// authenticated user (router-level requireAuth is the only gate) since
// both the submitting consultant (context for the Workforce Partner) and
// the Workforce Partner themselves (their own visit notes) need to write
// here — deleting stays admin/super_admin only, below.
router.get('/:id/notes', leadsViewAccess, async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at ASC',
      args: [req.params.id]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/notes', async (req, res) => {
  try {
    const note = (req.body.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Note text is required' });

    const lead = await getDb().execute({ sql: 'SELECT id FROM leads WHERE id = ?', args: [req.params.id] });
    if (!lead.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    const id = uuidv4();
    await getDb().execute({
      sql: 'INSERT INTO lead_notes (id, lead_id, note, author_name, author_email) VALUES (?, ?, ?, ?, ?)',
      args: [id, req.params.id, note, req.user.name || req.user.email, req.user.email]
    });
    const result = await getDb().execute({ sql: 'SELECT * FROM lead_notes WHERE id = ?', args: [id] });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/notes/:noteId', requireAdmin, async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM lead_notes WHERE id = ? AND lead_id = ?', args: [req.params.noteId, req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Structured call/visit log for leads — the /wfp mobile app's "Log a phone
// call"/"Log a visit" (2026-09-03). Same 4-part shape as centre_visits
// (routes/centres.js's own POST /:centreKey/visits): who they spoke with,
// the outcome, market intelligence, and what's next + when. See
// db/schema.sql's lead_activities comment for why this is a real table
// rather than folding into lead_notes' flat thread.
router.get('/:id/activities', leadsViewAccess, async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC',
      args: [req.params.id]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/activities', async (req, res) => {
  const { channel, contactName, outcome, notes, opportunityNotes, nextStep, nextStepDueDate } = req.body;
  if (!channel) return res.status(400).json({ error: 'channel is required' });
  try {
    const lead = await getDb().execute({ sql: 'SELECT id FROM leads WHERE id = ?', args: [req.params.id] });
    if (!lead.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    const id = uuidv4();
    await getDb().execute({
      sql: `INSERT INTO lead_activities (
              id, lead_id, channel, contact_name, outcome, notes, opportunity_notes,
              next_step, next_step_due_date, created_by_email, created_by_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, req.params.id, channel, contactName || null, outcome || null, notes || null,
        opportunityNotes || null, nextStep || null, nextStepDueDate || null,
        req.user.email, req.user.name || req.user.email
      ]
    });
    const row = (await getDb().execute({ sql: 'SELECT * FROM lead_activities WHERE id = ?', args: [id] })).rows[0];
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Site-visit recordings — same access shape as notes (readable by anyone
// with leads view access, uploadable/deletable by the people actually
// managing a lead day to day). Any file format, see leadRecordingUpload.
router.get('/:id/recordings', leadsViewAccess, async (req, res) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT id, filename, mimetype, filesize, uploaded_by_name, uploaded_by_email, created_at FROM lead_recordings WHERE lead_id = ? ORDER BY created_at DESC',
      args: [req.params.id]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/recordings', requireRole('admin', 'super_admin', 'workforce_partner'), leadRecordingUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = getDb();
    const lead = await db.execute({ sql: 'SELECT id FROM leads WHERE id = ?', args: [req.params.id] });
    if (!lead.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    const result = await db.execute({
      sql: `INSERT INTO lead_recordings (lead_id, filename, mimetype, filesize, uploaded_by_email, uploaded_by_name)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.user.email, req.user.name || req.user.email]
    });
    const recordingId = result.rows[0].id;
    const storagePath = `${req.params.id}/${recordingId}.${extForMimetype(req.file.mimetype)}`;
    await ensureBucket(BUCKETS.leadRecordings);
    await uploadBuffer(BUCKETS.leadRecordings, storagePath, req.file.buffer, req.file.mimetype);
    await db.execute({ sql: 'UPDATE lead_recordings SET storage_path = ? WHERE id = ?', args: [storagePath, recordingId] });

    res.json({ success: true, id: recordingId, filename: req.file.originalname, filesize: req.file.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Start Recording Notes" (Site Visit Recordings, Joy 2026-09-02) — a
// phone-mic voice note, saved as a real recording the same way the plain
// upload above does, PLUS a best-effort transcript+summary in the same
// round trip so the modal can offer "Add Note" immediately instead of
// someone typing up what they just said out loud. The recording always
// saves regardless of whether the AI steps succeed — same "never blocks
// the real artifact" posture as analyzeVisitFromTranscript itself; a
// missing/failed GROQ_API_KEY (transcription) or ANTHROPIC_API_KEY
// (summary) just means notesSummary comes back null and the recording is
// still there to play back and note up by hand.
router.post('/:id/recordings/voice-note', requireRole('admin', 'super_admin', 'workforce_partner'), leadRecordingUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No recording received' });
  try {
    const db = getDb();
    const lead = await db.execute({ sql: 'SELECT id, centre_name FROM leads WHERE id = ?', args: [req.params.id] });
    if (!lead.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    const result = await db.execute({
      sql: `INSERT INTO lead_recordings (lead_id, filename, mimetype, filesize, uploaded_by_email, uploaded_by_name)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.user.email, req.user.name || req.user.email]
    });
    const recordingId = result.rows[0].id;
    const storagePath = `${req.params.id}/${recordingId}.${extForMimetype(req.file.mimetype)}`;
    await ensureBucket(BUCKETS.leadRecordings);
    await uploadBuffer(BUCKETS.leadRecordings, storagePath, req.file.buffer, req.file.mimetype);
    await db.execute({ sql: 'UPDATE lead_recordings SET storage_path = ? WHERE id = ?', args: [storagePath, recordingId] });

    let notesSummary = null;
    try {
      if (groqTranscription.isConfigured()) {
        const transcript = await groqTranscription.transcribeAudio(req.file.buffer.toString('base64'), req.file.mimetype);
        notesSummary = (await analyzeVisitFromTranscript(transcript, lead.rows[0].centre_name)).notesSummary;
      }
    } catch (err) {
      console.error(`Voice-note transcription/summary failed for lead ${req.params.id} (non-fatal — recording is still saved):`, err.message);
    }

    res.json({ success: true, id: recordingId, filename: req.file.originalname, filesize: req.file.size, notesSummary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recordings/:recordingId/download', leadsViewAccess, async (req, res) => {
  try {
    const file = (await getDb().execute({ sql: 'SELECT * FROM lead_recordings WHERE id = ?', args: [req.params.recordingId] })).rows[0];
    if (!file) return res.status(404).json({ error: 'Recording not found' });
    if (!file.storage_path) return res.status(404).json({ error: 'This recording has no stored content' });
    const buffer = await downloadAsBuffer(BUCKETS.leadRecordings, file.storage_path);
    setFileResponseHeaders(res, { mimetype: file.mimetype, filename: file.filename, wantInline: false });
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/recordings/:recordingId', requireRole('admin', 'super_admin', 'workforce_partner'), async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.execute({ sql: 'SELECT storage_path FROM lead_recordings WHERE id = ?', args: [req.params.recordingId] });
    await db.execute({ sql: 'DELETE FROM lead_recordings WHERE id = ?', args: [req.params.recordingId] });
    if (existing.rows[0]?.storage_path) {
      try { await removeFile(BUCKETS.leadRecordings, existing.rows[0].storage_path); } catch { /* orphaned storage object, non-fatal */ }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
