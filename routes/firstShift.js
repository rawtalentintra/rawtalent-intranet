const express = require('express');
const router = express.Router();
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const rtApi = require('../services/rtApiReportService');
const { findFirstShifts, LOOKBACK_DAYS, OVERDUE_AFTER_DAYS } = require('../services/firstShiftService');
const { getCentresAndBookings } = require('./centres');

// Preview: super_admin only until Joy opens it up to the people who'll use it
// (Lorie/Marsha/Aiden — see the 2 Sep "First Shift Completion" project).
router.use(requireSuperAdmin);

const STATUSES = ['to_call', 'called', 'no_answer', 'done'];
const FEEDBACK = ['positive', 'neutral', 'negative'];

// The booking fetch is the slow part (RT returns thousands of rows page by
// page), so keep it in memory. Past the TTL the stale copy is served straight
// away while a fresh one loads in the background — only the very first load
// after a deploy actually waits on RT.
const CACHE_TTL_MS = 30 * 60 * 1000;
let bookingCache = { rows: null, expiresAt: 0 };
let refreshing = null;
function refreshBookings() {
  if (refreshing) return refreshing;
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  refreshing = rtApi.fetchAllPages('bookings', { startDate: start }, { tolerateFailures: true })
    .then(({ items }) => { bookingCache = { rows: items, expiresAt: Date.now() + CACHE_TTL_MS }; return items; })
    .finally(() => { refreshing = null; });
  return refreshing;
}
async function getBookings() {
  if (bookingCache.rows) {
    if (Date.now() >= bookingCache.expiresAt) refreshBookings().catch(() => {});
    return bookingCache.rows;
  }
  return refreshBookings();
}

router.get('/', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
    const db = getDb();
    const [bookings, candRows, followRows, userRows, centreData] = await Promise.all([
      getBookings(),
      db.execute({ sql: `SELECT user_id::text AS user_id, first_name, last_name, contact_no, email, created_date FROM rt_candidates_cache WHERE is_deleted = false AND created_date >= now() - (? || ' days')::interval`, args: [String(LOOKBACK_DAYS)] }),
      db.execute({ sql: 'SELECT * FROM first_shift_followups', args: [] }),
      db.execute({ sql: "SELECT email, name FROM users WHERE active = true ORDER BY name", args: [] }),
      getCentresAndBookings().catch(() => ({ centres: [] }))
    ]);
    const candidatesById = new Map(candRows.rows.map(r => [String(r.user_id), {
      name: [r.first_name, r.last_name].filter(Boolean).join(' '), phone: r.contact_no, email: r.email, createdDate: r.created_date
    }]));
    const followById = new Map(followRows.rows.map(r => [String(r.educator_user_id), r]));
    const centres = centreData.centres || [];
    const centreFor = s => centres.find(c => s.locationId != null && c.rtLocationId === s.locationId)
      || centres.find(c => s.clientId != null && c.rtClientId === s.clientId) || null;

    const shifts = findFirstShifts(bookings, candidatesById, { days }).map(s => {
      const f = followById.get(s.educatorUserId);
      const c = centreFor(s);
      const status = f ? f.status : 'to_call';
      return {
        ...s,
        centreKey: c ? c.centreKey : null,
        centreContactName: c ? c.contactName : null,
        centreContactNo: c ? c.contactNo : null,
        status,
        assignedToEmail: f ? f.assigned_to_email : null,
        centreFeedback: f ? f.centre_feedback : null,
        addedToFavourites: f ? !!f.added_to_favourites : false,
        notes: f ? f.notes : null,
        updatedBy: f ? f.updated_by : null,
        updatedAt: f ? f.updated_at : null,
        overdue: status !== 'done' && s.daysSince > OVERDUE_AFTER_DAYS
      };
    });
    res.json({ days, overdueAfterDays: OVERDUE_AFTER_DAYS, shifts, assignees: userRows.rows, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Upsert what a person has done about one educator's first shift. Only the
// fields sent are changed, so each control on the page can save on its own.
router.put('/:educatorUserId', async (req, res) => {
  const b = req.body || {};
  if ('status' in b && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
  if ('centreFeedback' in b && b.centreFeedback && !FEEDBACK.includes(b.centreFeedback)) return res.status(400).json({ error: 'Invalid feedback' });
  try {
    const db = getDb();
    const id = String(req.params.educatorUserId);
    const existing = (await db.execute({ sql: 'SELECT * FROM first_shift_followups WHERE educator_user_id = ?', args: [id] })).rows[0] || {};
    const pick = (key, col, fallback = null) => (key in b ? (b[key] === '' ? null : b[key]) : (existing[col] ?? fallback));
    await db.execute({
      sql: `INSERT INTO first_shift_followups
              (educator_user_id, first_shift_booking_id, first_shift_date, centre_name, status, assigned_to_email, centre_feedback, added_to_favourites, notes, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (educator_user_id) DO UPDATE SET
              first_shift_booking_id = excluded.first_shift_booking_id, first_shift_date = excluded.first_shift_date, centre_name = excluded.centre_name,
              status = excluded.status, assigned_to_email = excluded.assigned_to_email, centre_feedback = excluded.centre_feedback,
              added_to_favourites = excluded.added_to_favourites, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now()`,
      args: [
        id, pick('bookingId', 'first_shift_booking_id'), pick('firstShiftDate', 'first_shift_date'), pick('centreName', 'centre_name'),
        pick('status', 'status', 'to_call'), pick('assignedToEmail', 'assigned_to_email'), pick('centreFeedback', 'centre_feedback'),
        'addedToFavourites' in b ? !!b.addedToFavourites : !!existing.added_to_favourites, pick('notes', 'notes'), req.user.email
      ]
    });
    const row = (await db.execute({ sql: 'SELECT * FROM first_shift_followups WHERE educator_user_id = ?', args: [id] })).rows[0];
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Load the bookings shortly after boot so the first person to open the page
// doesn't sit through the ~45s RT fetch. Failure is fine — the first real
// request just does the fetch itself.
setTimeout(() => { refreshBookings().catch(() => {}); }, 60 * 1000).unref();

module.exports = router;
