const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');

router.use(requireAuth);

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
      contactFirstName, contactLastName, contactEmail
    } = req.body;
    if (!centreName?.trim()) return res.status(400).json({ error: 'Centre name is required' });

    const id = uuidv4();
    const assignedWorkforcePartner = STATE_WORKFORCE_PARTNER[state] || null;
    await getDb().execute({
      sql: `INSERT INTO leads (
              id, centre_name, street_address, suburb, state, centre_phone,
              educator_name, agency_name, number_of_shifts, agency_usage, position,
              contact_first_name, contact_last_name, contact_email,
              submitted_by_email, submitted_by_name, assigned_workforce_partner
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, centreName.trim(), streetAddress?.trim() || null, suburb?.trim() || null, state || null, centrePhone?.trim() || null,
        educatorName?.trim() || null, agencyName?.trim() || null, numberOfShifts?.trim() || null, agencyUsage || null, position || null,
        contactFirstName?.trim() || null, contactLastName?.trim() || null, contactEmail?.trim() || null,
        req.user.email, req.user.name || req.user.email, assignedWorkforcePartner
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

router.get('/', requireAdmin, async (req, res) => {
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

router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-only edit — in practice just setting who's following it up, but
// allows correcting any field in case something was mistyped at submission.
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await getDb().execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    const fields = {
      centre_name: 'centreName', street_address: 'streetAddress', suburb: 'suburb', state: 'state', centre_phone: 'centrePhone',
      educator_name: 'educatorName', agency_name: 'agencyName', number_of_shifts: 'numberOfShifts', agency_usage: 'agencyUsage', position: 'position',
      contact_first_name: 'contactFirstName', contact_last_name: 'contactLastName', contact_email: 'contactEmail',
      assigned_workforce_partner: 'assignedWorkforcePartner',
      lead_called_status: 'leadCalledStatus', lead_called_at: 'leadCalledAt',
      centre_visited_status: 'centreVisitedStatus', centre_visited_at: 'centreVisitedAt',
      signed_status: 'signedStatus', signed_at: 'signedAt'
    };
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
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
