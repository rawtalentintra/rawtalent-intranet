// Consultant monthly call list (Liam, 26 Oct 2026): every centre gets a
// consultant call about once a month. Liam doesn't want to annoy them, so it's
// monthly, not more. The list covers:
//  - leads that a Workforce Partner has already called or visited (pre-booking).
//    New leads stay with the WFPs until then (leadFunnelService "new_wfp").
//  - existing RT centres that have booked in the last 6 months.
// Due when there's been no consultant call for 30 days (or the call-back date
// set on the last call has arrived). Calls are logged in consultant_calls.
const { getDb } = require('../db/database');

const OUTCOMES = {
  booked: 'Needs someone next week → booked', fbf: 'Offered first booking free', check_in: 'Check-in done',
  issue: 'Issue raised', call_back: 'Call back later'
};
const CADENCE_DAYS = 30;
const DAY = 864e5;

async function lastCalls() {
  const rows = (await getDb().execute({
    sql: `SELECT DISTINCT ON (COALESCE(centre_key, 'lead:' || lead_id)) COALESCE(centre_key, 'lead:' || lead_id) k, outcome, call_back_on, called_by_name, called_at
          FROM consultant_calls ORDER BY COALESCE(centre_key, 'lead:' || lead_id), called_at DESC`, args: []
  })).rows;
  return new Map(rows.map(r => [r.k, r]));
}

async function dueList({ state = null, includeAll = false } = {}) {
  const db = getDb();
  const centresMod = require('../routes/centres');
  const funnel = await require('./leadFunnelService').computeStages();
  const last = await lastCalls();
  const now = Date.now();
  const items = [];
  const push = (base, k) => {
    const lc = last.get(k);
    const next = lc ? (lc.call_back_on ? new Date(lc.call_back_on).getTime() : new Date(lc.called_at).getTime() + CADENCE_DAYS * DAY) : null;
    const due = !lc || next <= now;
    if (!includeAll && !due) return;
    items.push({ ...base, key: k, lastCall: lc ? { at: lc.called_at, by: lc.called_by_name, outcome: lc.outcome } : null, nextDue: next ? new Date(next).toISOString().slice(0, 10) : null, overdueDays: next ? Math.floor((now - next) / DAY) : null, due });
  };
  // Leads in pre-booking (contacted by a WFP or already with consultants, not set up yet)
  const leads = (await db.execute({ sql: 'SELECT id, centre_name, suburb, state, centre_phone, contact_first_name, contact_last_name, service_type, group_category FROM leads WHERE archived_at IS NULL AND closed_at IS NULL', args: [] })).rows;
  const cat = require('./leadCategoryService');
  for (const l of leads) {
    const st = funnel.byLead[l.id]?.stage;
    if (!['contacted_wfp', 'consultant'].includes(st)) continue;
    if (state && String(l.state || '').toUpperCase() !== state) continue;
    push({ kind: 'lead', leadId: l.id, name: l.centre_name, suburb: l.suburb, state: String(l.state || '').toUpperCase(), phone: l.centre_phone,
      contact: [l.contact_first_name, l.contact_last_name].filter(x => x && !/not provided/i.test(x)).join(' ') || null, stage: st, category: cat.label(l.service_type, l.group_category) }, `lead:${l.id}`);
  }
  // Existing centres booking in the last 6 months
  try {
    const { centres, bookings } = await centresMod.getCentresAndBookings();
    const hidden = await centresMod.getHiddenCentreKeys();
    const idx = centresMod.indexBookingsByCentre(bookings);
    const cats = new Map((await db.execute({ sql: 'SELECT centre_key, service_type, group_category FROM centre_categories', args: [] })).rows.map(r => [r.centre_key, r]));
    const offers = new Set((await db.execute({ sql: 'SELECT centre_key FROM first_booking_free_offers WHERE centre_key IS NOT NULL', args: [] })).rows.map(r => r.centre_key));
    for (const c of centres) {
      if (hidden.has(c.centreKey)) continue;
      const bs = centresMod.bookingsForCentre(idx, c).filter(b => [1, 2, 3, 5].includes(b.statusId) && b.bookingDate && new Date(b.bookingDate).getTime() <= now);
      if (!bs.length || now - Math.max(...bs.map(b => new Date(b.bookingDate).getTime())) > 182 * DAY) continue;
      const st = centresMod.shortState(c.state);
      if (state && st !== state) continue;
      const cc = cats.get(c.centreKey);
      push({ kind: 'centre', name: c.name, suburb: c.suburb, state: st, phone: c.contactNo, contact: c.contactName || null, stage: 'centre',
        category: cc ? cat.label(cc.service_type, cc.group_category) : null, fbfOffered: offers.has(c.centreKey) }, c.centreKey);
    }
  } catch (err) { items.push({ kind: 'error', name: 'RT centres could not be loaded right now', key: 'rt-error' }); }
  items.sort((a, b) => (a.lastCall ? 1 : 0) - (b.lastCall ? 1 : 0) || (b.overdueDays ?? 999) - (a.overdueDays ?? 999) || String(a.name).localeCompare(String(b.name)));
  return { items, outcomes: OUTCOMES, cadenceDays: CADENCE_DAYS };
}

async function logCall({ leadId, centreKey, outcome, notes, callBackOn }, user) {
  if (!OUTCOMES[outcome]) throw Object.assign(new Error('Pick an outcome'), { status: 400 });
  if (!leadId && !centreKey) throw Object.assign(new Error('leadId or centreKey is required'), { status: 400 });
  if (outcome === 'call_back' && callBackOn && !/^\d{4}-\d{2}-\d{2}$/.test(callBackOn)) throw Object.assign(new Error('Call-back date must be a date'), { status: 400 });
  let name = null;
  if (leadId) name = (await getDb().execute({ sql: 'SELECT centre_name FROM leads WHERE id = ?', args: [leadId] })).rows[0]?.centre_name;
  const row = (await getDb().execute({
    sql: `INSERT INTO consultant_calls (lead_id, centre_key, target_name, outcome, notes, call_back_on, called_by_email, called_by_name) VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
    args: [leadId || null, centreKey || null, name, outcome, String(notes || '').trim().slice(0, 2000) || null, outcome === 'call_back' && callBackOn ? callBackOn : null, user.email, user.name || user.email]
  })).rows[0];
  require('./leadFunnelService').invalidate();
  return row;
}

module.exports = { OUTCOMES, CADENCE_DAYS, dueList, logCall };
