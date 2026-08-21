const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin, requireSuperAdmin, requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const { syncLeadEventOutbound } = require('../services/leadCalendarSyncService');
const rtApi = require('../services/rtApiReportService');
const centreMatchService = require('../services/centreMatchService');
const { keyForLocation, keyForClient } = require('../services/centreKeyService');
const { MEANINGFUL_BOOKING_STATUSES } = require('../services/centreHealthService');
const { visitsByCentreKey } = require('./centres');
const { BUCKETS, uploadBuffer, downloadAsBuffer, remove: removeFile, extForMimetype, ensureBucket } = require('../services/storageService');
const { partnerForSuburbState } = require('../services/melbourneTerritoryService');

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
  SA: 'Gwen Stocks (SA)'
};

function autoAssignWorkforcePartner(suburb, state) {
  return partnerForSuburbState(suburb, state) || STATE_WORKFORCE_PARTNER[state] || null;
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
    await getDb().execute({
      sql: `INSERT INTO leads (
              id, centre_name, street_address, suburb, state, centre_phone,
              educator_name, agency_name, number_of_shifts, agency_usage, position,
              contact_first_name, contact_last_name, contact_email,
              submitted_by_email, submitted_by_name, assigned_workforce_partner, entry_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, centreName.trim(), streetAddress?.trim() || null, suburb?.trim() || null, state || null, centrePhone?.trim() || null,
        educatorName?.trim() || null, agencyName?.trim() || null, numberOfShifts?.trim() || null, agencyUsage || null, position || null,
        contactFirstName?.trim() || null, contactLastName?.trim() || null, contactEmail?.trim() || null,
        req.user.email, req.user.name || req.user.email, assignedWorkforcePartner, resolvedEntryType
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

router.get('/', leadsViewAccess, async (req, res) => {
  try {
    const result = await getDb().execute('SELECT * FROM leads ORDER BY created_at DESC');
    res.json(result.rows);
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
router.get('/check-duplicate', async (req, res) => {
  try {
    const centreName = (req.query.centreName || '').trim();
    const streetAddress = (req.query.streetAddress || '').trim();

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

    res.json({ centreMatches, addressMatches });
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
        args.push(req.body[bodyKey] || null);
      }
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

    // Outbound calendar sync — fire-and-forget, after the response is sent,
    // so a Google API hiccup never delays or fails the status update itself.
    if ('leadCalledStatus' in req.body && updated.lead_called_status === 'scheduled' && updated.lead_called_at) {
      syncLeadEventOutbound(updated, 'call');
    }
    if ('centreVisitedStatus' in req.body && updated.centre_visited_status === 'scheduled' && updated.centre_visited_at) {
      syncLeadEventOutbound(updated, 'visit');
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Close out" a lead — covers both "fully done, Profile Created, nothing
// left to track" and "this one's dead, stop chasing it". Kept as its own
// endpoint rather than folded into the generic field-mapping PUT above,
// since closed_at/closed_by_email need to come from the server session,
// not a client-supplied value. Reopening (closed: false) just clears
// both columns — nothing else about the lead is touched either way.
router.patch('/:id/closed', requireRole('admin', 'super_admin', 'workforce_partner'), async (req, res) => {
  const { closed } = req.body;
  if (typeof closed !== 'boolean') return res.status(400).json({ error: 'closed must be a boolean' });
  try {
    const existing = await getDb().execute({ sql: 'SELECT id FROM leads WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    await getDb().execute({
      sql: 'UPDATE leads SET closed_at = ?, closed_by_email = ?, updated_at = now() WHERE id = ?',
      args: [closed ? new Date().toISOString() : null, closed ? req.user.email : null, req.params.id]
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

router.get('/recordings/:recordingId/download', leadsViewAccess, async (req, res) => {
  try {
    const file = (await getDb().execute({ sql: 'SELECT * FROM lead_recordings WHERE id = ?', args: [req.params.recordingId] })).rows[0];
    if (!file) return res.status(404).json({ error: 'Recording not found' });
    if (!file.storage_path) return res.status(404).json({ error: 'This recording has no stored content' });
    const buffer = await downloadAsBuffer(BUCKETS.leadRecordings, file.storage_path);
    res.setHeader('Content-Type', file.mimetype);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
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
