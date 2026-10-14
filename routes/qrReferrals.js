// QR Code Educator Recruitment (Liam, 13 Oct 2026) — Phase 1.
//
// Two routers:
//  - publicRouter: the landing-page form posts here. No login (educators
//    aren't HeartBeat users), so it is protected by a shared form key
//    (QR_FORM_KEY env var, sent as the X-Form-Key header) plus a rate limit.
//    If QR_FORM_KEY isn't set the endpoint refuses everything.
//  - router: the Operations view (priority onboarding list, pay rate and
//    welcome bonus fields). super_admin only while it is a preview.
//
// HeartBeat never writes to RT: matching to an RT educator is read-only,
// from rt_candidates_cache.
const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { requireSuperAdmin } = require('../middleware/authMiddleware');
const { getCentresAndBookings, getCentrePartnerAssignments } = require('./centres');
const { partnerForSuburbState } = require('../services/melbourneTerritoryService');

const STATUSES = ['new', 'contacted', 'onboarding', 'active', 'not_proceeding'];
const STATE_DEFAULT_PARTNER = { VIC: 'Justine', SA: 'Gwen', QLD: 'Gwen' };
const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || null;
const digits = v => String(v || '').replace(/\D/g, '');
const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const shortState = s => {
  const v = norm(s);
  return { victoria: 'VIC', vic: 'VIC', 'south australia': 'SA', sa: 'SA', queensland: 'QLD', qld: 'QLD', 'new south wales': 'NSW', nsw: 'NSW', 'australian capital territory': 'ACT', act: 'ACT', 'northern territory': 'NT', nt: 'NT', 'western australia': 'WA', wa: 'WA', tasmania: 'TAS', tas: 'TAS' }[v] || null;
};

// Best-effort match of the centre name the educator typed to a real RT centre.
// Only accepts a confident match (exact, or one name containing the other and
// no second candidate) — otherwise leaves it for a person to pick.
async function matchCentre(entered) {
  const q = norm(entered);
  if (q.length < 4) return null;
  const { centres } = await getCentresAndBookings();
  const exact = centres.filter(c => norm(c.name) === q);
  if (exact.length === 1) return exact[0].centreKey;
  const partial = centres.filter(c => { const n = norm(c.name); return n.includes(q) || q.includes(n); });
  return partial.length === 1 ? partial[0].centreKey : null;
}

// ── Public form endpoint ─────────────────────────────────────────────
const publicRouter = express.Router();
publicRouter.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true }));
publicRouter.post('/', async (req, res) => {
  // Trimmed: a stray space or newline pasted into Railway's Variables tab shouldn't lock the form out.
  const key = (process.env.QR_FORM_KEY || '').trim().replace(/^["']|["']$/g, '');
  const given = String(req.get('x-form-key') || '').trim();
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return res.status(401).json({ error: 'Not authorised' });
  }
  const b = req.body || {};
  const firstName = clean(b.firstName, 80);
  const centre = clean(b.centreName, 200);
  const email = clean(b.email, 200);
  const phone = clean(b.phone, 40);
  if (!firstName || !centre || (!email && !phone)) {
    return res.status(400).json({ error: 'First name, centre name and an email or phone number are required' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email address looks invalid' });
  try {
    const centreKey = await matchCentre(centre).catch(() => null);
    const row = (await getDb().execute({
      sql: `INSERT INTO qr_referrals (first_name, last_name, email, phone, suburb, state, qualification, centre_name_entered, centre_key, current_agency, submitted_ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [firstName, clean(b.lastName, 80), email, phone, clean(b.suburb, 80), shortState(b.state) || clean(b.state, 40), clean(b.qualification, 120), centre, centreKey, clean(b.currentAgency, 120), req.ip]
    })).rows[0];
    res.status(201).json({ success: true, id: row.id });
  } catch (err) {
    console.error('QR referral submit failed:', err.message);
    res.status(500).json({ error: 'Could not save your details, please try again' });
  }
});

// ── Operations view ──────────────────────────────────────────────────
const router = express.Router();
router.use(requireSuperAdmin);

const OB_STEPS = ['Register', 'About Us', 'Profile Image', 'Experience', 'Emergency Contact', 'Qualification Level', 'Reference', 'Visa', 'Finance', 'Tax', 'Documents', 'Completed'];

router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const rows = (await db.execute({ sql: 'SELECT * FROM qr_referrals ORDER BY created_at DESC', args: [] })).rows;

    // Match to RT educators (read-only) by email, else by phone digits.
    const emails = rows.map(r => (r.email || '').toLowerCase()).filter(Boolean);
    const phones = rows.map(r => digits(r.phone).slice(-9)).filter(p => p.length === 9);
    const rt = emails.length || phones.length ? (await db.execute({
      sql: `SELECT user_id::text uid, lower(email) email, right(regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g'), 9) phone9,
                   status, raw->>'statusName' status_name, raw->>'obStatus' ob_status, (raw->>'onBoardingStep')::int ob_step, created_date
            FROM rt_candidates_cache
            WHERE is_deleted IS NOT TRUE AND (lower(email) = ANY(?) OR right(regexp_replace(coalesce(contact_no,''), '[^0-9]', '', 'g'), 9) = ANY(?))`,
      args: [emails, phones]
    })).rows : [];
    const byEmail = new Map(rt.map(c => [c.email, c]));
    // A phone match only counts when exactly one RT educator has that number and
    // it isn't a placeholder (e.g. 0400 000 000 — real RT records carry these).
    const phoneCount = new Map();
    rt.forEach(c => c.phone9 && phoneCount.set(c.phone9, (phoneCount.get(c.phone9) || 0) + 1));
    const placeholder = p => /(\d)\1{5,}/.test(p);
    const byPhone = new Map(rt.filter(c => c.phone9 && phoneCount.get(c.phone9) === 1 && !placeholder(c.phone9)).map(c => [c.phone9, c]));

    const { centres } = await getCentresAndBookings();
    const centreByKey = new Map(centres.map(c => [c.centreKey, c]));
    const assignments = await getCentrePartnerAssignments();

    const out = rows.map(r => {
      const m = (r.rt_user_id && rt.find(c => c.uid === r.rt_user_id)) || byEmail.get((r.email || '').toLowerCase()) || byPhone.get(digits(r.phone).slice(-9)) || null;
      const c = r.centre_key ? centreByKey.get(r.centre_key) : null;
      const partner = c ? (assignments[c.centreKey] || partnerForSuburbState(c.suburb, c.state) || STATE_DEFAULT_PARTNER[shortState(c.state)] || null) : null;
      const daysWaiting = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000);
      return {
        id: r.id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, suburb: r.suburb, state: r.state,
        qualification: r.qualification, centreNameEntered: r.centre_name_entered, currentAgency: r.current_agency,
        centreKey: r.centre_key, centreName: c ? c.name : null, partner,
        status: r.status, assignedToEmail: r.assigned_to_email, currentAgencyRate: r.current_agency_rate, offeredRate: r.offered_rate,
        bonusEligible: r.bonus_eligible, bonusTaskId: r.bonus_task_id, firstShiftDate: r.first_shift_date, notes: r.notes, createdAt: r.created_at, daysWaiting,
        rt: m ? { userId: m.uid, status: m.status_name || m.status, obStatus: m.ob_status, obStep: m.ob_step, obStepName: OB_STEPS[m.ob_step] || null } : null
      };
    });
    const assignees = (await db.execute({ sql: "SELECT email, name FROM users WHERE active = true AND role IN ('admin','super_admin') ORDER BY name", args: [] })).rows;
    res.json({ referrals: out, assignees, centres: centres.map(c => ({ key: c.centreKey, name: c.name, state: c.state })), formKeyConfigured: !!(process.env.QR_FORM_KEY || '').trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const EDITABLE = {
  status: v => (STATUSES.includes(v) ? v : undefined),
  assignedToEmail: v => (v ? String(v).slice(0, 200) : null),
  currentAgencyRate: v => (v === '' || v == null ? null : Number.isFinite(+v) && +v >= 0 && +v < 1000 ? +v : undefined),
  offeredRate: v => (v === '' || v == null ? null : Number.isFinite(+v) && +v >= 0 && +v < 1000 ? +v : undefined),
  bonusEligible: v => (v === null || v === '' ? null : !!v),
  notes: v => (v ? String(v).slice(0, 2000) : null),
  centreKey: v => (v ? String(v).slice(0, 60) : null),
  rtUserId: v => (v ? String(v).replace(/\D/g, '').slice(0, 20) || null : null)
};
const COLUMN = { status: 'status', assignedToEmail: 'assigned_to_email', currentAgencyRate: 'current_agency_rate', offeredRate: 'offered_rate', bonusEligible: 'bonus_eligible', notes: 'notes', centreKey: 'centre_key', rtUserId: 'rt_user_id' };

router.put('/:id', async (req, res) => {
  const sets = [], args = [];
  for (const [k, fn] of Object.entries(EDITABLE)) {
    if (!(k in (req.body || {}))) continue;
    const v = fn(req.body[k]);
    if (v === undefined) return res.status(400).json({ error: `Invalid value for ${k}` });
    sets.push(`${COLUMN[k]} = ?`); args.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    const r = await getDb().execute({ sql: `UPDATE qr_referrals SET ${sets.join(', ')}, updated_at = now() WHERE id = ? RETURNING *`, args: [...args, req.params.id] });
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, publicRouter };
