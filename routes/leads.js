const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin, requireSuperAdmin, requireRole } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const { syncLeadEventOutbound } = require('../services/leadCalendarSyncService');

router.use(requireAuth);

// qa_view gets read-only access to the admin Leads list/detail (not the
// Sales Dashboard, which reuses this same data client-side but is kept
// off qa_view's nav for now). workforce_partner gets both Leads and Sales
// Dashboard, plus limited edit rights — see PUT /:id below.
const leadsViewAccess = requireRole('admin', 'super_admin', 'qa_view', 'workforce_partner');

// State -> Workforce Partner auto-assignment. Still overridable afterwards
// via PUT — this just sets a sensible default so nothing sits unassigned.
const STATE_WORKFORCE_PARTNER = {
  SA: 'Gwen Stocks (SA)',
  VIC: 'Justine Hardware (VIC)'
};

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
    const assignedWorkforcePartner = STATE_WORKFORCE_PARTNER[state] || null;
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
// centre, from the Leads list in their own view. workforce_partner is
// restricted to exactly these 4 columns; admin/super_admin can edit
// everything (status, assignment, and the original submission fields too,
// in case something was mistyped).
const WORKFORCE_PARTNER_FIELDS = {
  position: 'position', contact_first_name: 'contactFirstName', contact_last_name: 'contactLastName', contact_email: 'contactEmail'
};
const ADMIN_FIELDS = {
  centre_name: 'centreName', street_address: 'streetAddress', suburb: 'suburb', state: 'state', centre_phone: 'centrePhone',
  educator_name: 'educatorName', agency_name: 'agencyName', number_of_shifts: 'numberOfShifts', agency_usage: 'agencyUsage',
  ...WORKFORCE_PARTNER_FIELDS,
  assigned_workforce_partner: 'assignedWorkforcePartner',
  lead_called_status: 'leadCalledStatus', lead_called_at: 'leadCalledAt',
  centre_visited_status: 'centreVisitedStatus', centre_visited_at: 'centreVisitedAt',
  signed_status: 'signedStatus', signed_at: 'signedAt'
};

router.put('/:id', requireRole('admin', 'super_admin', 'workforce_partner'), async (req, res) => {
  try {
    const existing = await getDb().execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    const fields = req.user.role === 'workforce_partner' ? WORKFORCE_PARTNER_FIELDS : ADMIN_FIELDS;
    const sets = [];
    const args = [];
    for (const [column, bodyKey] of Object.entries(fields)) {
      if (bodyKey in req.body) {
        sets.push(`${column} = ?`);
        args.push(req.body[bodyKey] || null);
      }
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

module.exports = router;
